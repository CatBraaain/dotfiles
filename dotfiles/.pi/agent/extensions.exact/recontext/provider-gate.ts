import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAssistantMessageEventStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  compactionCandidates,
  requestFits,
  summaryRequestOptions,
  type CompactionOptions,
} from "./auto-compaction.ts";
import {
  createReplacement,
  isReplacementCurrent,
  matchMessageSources,
  pendingProjection,
  REPLACEMENT_STATE,
  replaceRequestMessages,
} from "./projection.ts";
import { PROVIDER_UPDATE_EVENT, type ProviderUpdate } from "./provider-update.ts";

interface Registration {
  wrapper: Provider;
  base: Provider;
  ready: boolean;
  native: Provider | undefined;
  legacy: ProviderConfig | undefined;
}

export interface ProviderGates {
  ensure(): Promise<void>;
  close(): void;
  isBusy(): boolean;
}

interface SessionQueue {
  tail: Promise<void>;
  active: number;
  draining: number;
  owners: number;
}

const QUEUES_KEY = Symbol.for("dotfiles.recontext.session-queues.v1");
const shared = globalThis as typeof globalThis & { [QUEUES_KEY]?: Map<string, SessionQueue> };
const sessionQueues = (shared[QUEUES_KEY] ??= new Map<string, SessionQueue>());
const requestScope = new AsyncLocalStorage<SessionQueue>();
const SUMMARY_TIMEOUT_MS = 300_000;

export function installProviderGates(
  pi: ExtensionAPI,
  getContext: () => ExtensionContext,
): ProviderGates {
  const registry = getContext().modelRegistry;
  const registrations = new Map<string, Registration>();
  const lifetime = new AbortController();
  const sessionId = getContext().sessionManager.getSessionId();
  const queue = sessionQueues.get(sessionId) ?? {
    tail: Promise.resolve(),
    active: 0,
    draining: 0,
    owners: 0,
  };
  queue.owners++;
  sessionQueues.set(sessionId, queue);
  let closed = false;
  let active = false;
  let preparation: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let failure: { error: unknown } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = pi.events.on(PROVIDER_UPDATE_EVENT, (value) => {
    const update = value as ProviderUpdate;
    if (closed || update.registry !== registry || update.handled) return;
    update.handled = true;
    try {
      if (!active) update.register();
      else {
        restore(update.providerId);
        try {
          update.register();
        } finally {
          install(update.providerId);
        }
      }
      failure = undefined;
    } catch (error) {
      failPreparation(error);
      update.error = error;
    }
  });

  function pendingProviders(): string[] {
    const providers = new Set([
      ...registry.getAll().map((model) => model.provider),
      ...registry.getRegisteredProviderIds(),
    ]);
    return [...providers].filter((providerId) => {
      const registration = registrations.get(providerId);
      const native = registry.getRegisteredNativeProvider(providerId);
      return (
        (!registration?.ready || native !== registration.wrapper) &&
        Boolean(native ?? registry.getProvider(providerId))
      );
    });
  }

  function ensure(): Promise<void> {
    if (closed) return Promise.reject(new Error("Provider preparation owner is closed"));
    if (failure) return Promise.reject(failure.error);
    if (preparation) return preparation.promise;
    let pending: string[] = [];
    if (active) {
      try {
        pending = pendingProviders();
      } catch (error) {
        failPreparation(error);
        return Promise.reject(error);
      }
      if (!pending.length) return Promise.resolve();
    }
    active = true;
    const completion = Promise.withResolvers<void>();
    preparation = completion;
    function step(): void {
      timer = undefined;
      if (closed) return;
      try {
        if (!pending.length) pending = pendingProviders();
        const providerId = pending.shift();
        if (providerId !== undefined) install(providerId);
        if (!pending.length) pending = pendingProviders();
        if (pending.length) timer = setTimeout(step, 0);
        else {
          preparation = undefined;
          completion.resolve();
        }
      } catch (error) {
        failPreparation(error);
      }
    }
    timer = setTimeout(step, 0);
    return completion.promise;
  }

  function failPreparation(error: unknown): void {
    failure = { error };
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    preparation?.reject(error);
    preparation = undefined;
  }

  function assertPreparationHealthy(): void {
    if (failure) throw failure.error;
  }

  function install(providerId: string): void {
    const previous = registrations.get(providerId);
    const current = registry.getRegisteredNativeProvider(providerId);
    if (previous?.ready && current === previous.wrapper) return;
    const ownsCurrent = previous !== undefined && current === previous.wrapper;
    const native = ownsCurrent ? previous.native : current;
    const base = ownsCurrent ? previous.base : (native ?? registry.getProvider(providerId));
    if (!base) return;
    const legacy = ownsCurrent ? previous.legacy : registry.getRegisteredProviderConfig(providerId);
    function stream<T extends Api>(
      model: Model<T>,
      context: TranscriptContext,
      options?: ApiStreamOptions<T>,
    ): AssistantMessageEventStream {
      return enqueue(base!, model, context, options ?? {}, false);
    }
    function streamSimple(
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      return enqueue(base!, model, context, options ?? {}, true);
    }
    const wrapper: Provider = new Proxy(base, {
      get(target, key) {
        if (key === "stream") return stream;
        if (key === "streamSimple") return streamSimple;
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const registration = { wrapper, base, native, legacy, ready: false };
    registrations.set(providerId, registration);
    registry.registerProvider(wrapper);
    registration.ready = true;
  }

  function restore(providerId: string): void {
    const registration = registrations.get(providerId);
    registrations.delete(providerId);
    if (!registration || registry.getRegisteredNativeProvider(providerId) !== registration.wrapper)
      return;
    if (registration.native) registry.registerProvider(registration.native);
    else {
      registry.unregisterProvider(providerId);
      if (registration.legacy) registry.registerProvider(providerId, registration.legacy);
    }
  }

  function enqueue(
    base: Provider,
    model: Model<Api>,
    context: TranscriptContext,
    options: CompactionOptions,
    simple: boolean,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    if (requestScope.getStore() === queue || queue.draining > 0) {
      const message = failedMessage(
        model,
        new Error(
          requestScope.getStore() === queue
            ? "A reentrant provider request was blocked"
            : "A cancelled summary is still stopping; no request was sent",
        ),
        "aborted",
      );
      getContext().ui.notify(message.errorMessage!, "warning");
      output.push({ type: "error", reason: "aborted", error: message });
      output.end();
      return output;
    }
    queue.active++;
    const previous = queue.tail;
    const done = Promise.withResolvers<void>();
    queue.tail = previous.then(() => done.promise);
    const lease: { completion?: Promise<void> } = {};
    async function run(): Promise<void> {
      let delegated = false;
      try {
        await abortable(
          previous,
          AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]),
        );
        if (closed || lifetime.signal.aborted || options.signal?.aborted)
          throw new Error("The request was cancelled before dispatch");
        assertPreparationHealthy();
        const prepared = await prepare(base, model, context, options, simple, lease);
        assertPreparationHealthy();
        if (closed || options.signal?.aborted)
          throw new Error("The request was cancelled before normal dispatch");
        delegated = true;
        const normalOptions = {
          ...options,
          signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]),
        };
        const stream = simple
          ? base.streamSimple(model, prepared, normalOptions as SimpleStreamOptions)
          : base.stream(model, prepared, normalOptions as ApiStreamOptions<Api>);
        for await (const event of stream) output.push(event);
        output.end();
      } catch (error) {
        const message = failedMessage(model, error, delegated ? "error" : "aborted");
        if (!delegated && !closed) getContext().ui.notify(message.errorMessage!, "warning");
        output.push({ type: "error", reason: delegated ? "error" : "aborted", error: message });
        output.end();
      } finally {
        await lease.completion;
        queue.active--;
        done.resolve();
        releaseQueue();
      }
    }
    void requestScope.run(queue, run);
    return output;
  }

  async function prepare(
    base: Provider,
    model: Model<Api>,
    context: TranscriptContext,
    options: CompactionOptions,
    simple: boolean,
    lease: { completion?: Promise<void> },
  ): Promise<TranscriptContext> {
    const ctx = getContext();
    const manager = ctx.sessionManager;
    if (
      options.sessionId !== manager.getSessionId() ||
      requestFits(model, context, options, simple)
    )
      return context;
    const sessionId = manager.getSessionId();
    const leafId = manager.getLeafId();
    const projection = pendingProjection(manager).entries;
    const candidates = compactionCandidates(manager, projection, model, context, options, simple);
    const candidate = candidates[0];
    if (!candidate)
      throw new Error("No complete exchange boundary fits both summary and normal request budgets");
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
        ? options.timeoutMs!
        : SUMMARY_TIMEOUT_MS;
    const signals = [
      lifetime.signal,
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
      ...(ctx.signal ? [ctx.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const summaryOptions = {
      ...summaryRequestOptions(model, options, candidate.maxTokens, simple),
      signal,
    };
    const summaryStream = simple
      ? base.streamSimple(model, candidate.summaryContext, summaryOptions as SimpleStreamOptions)
      : base.stream(model, candidate.summaryContext, summaryOptions as ApiStreamOptions<Api>);
    const result = summaryStream.result();
    let settled = false;
    lease.completion = result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let summary: AssistantMessage;
    try {
      summary = await abortable(result, signal);
    } catch (error) {
      if (!settled) {
        queue.draining++;
        void lease.completion.then(() => {
          queue.draining--;
        });
      }
      throw error;
    }
    signal.throwIfAborted();
    const text = summary.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (
      summary.stopReason !== "stop" ||
      !text.trim() ||
      summary.content.some((block) => block.type === "toolCall")
    )
      throw new Error(
        `Summary was not accepted (${summary.stopReason}${text.trim() ? "" : ", empty"})`,
      );
    if (manager.getSessionId() !== sessionId || manager.getLeafId() !== leafId)
      throw new Error("The session or branch changed during summarization");
    const state = createReplacement(manager, projection, candidate.targetIds, text);
    if (!isReplacementCurrent(manager, pendingProjection(manager).entries, state))
      throw new Error("The summarized prefix changed before replacement");
    const compressed = {
      ...context,
      messages: replaceRequestMessages(
        context.messages,
        matchMessageSources(context.messages, projection),
        state,
      ),
    };
    if (!requestFits(model, compressed, options, simple))
      throw new Error("The generated summary does not fit the normal request budget");
    pi.appendEntry(REPLACEMENT_STATE, state);
    return compressed;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    preparation?.reject(new Error("Provider preparation owner is closed"));
    preparation = undefined;
    lifetime.abort();
    unsubscribe();
    try {
      for (const providerId of registrations.keys()) restore(providerId);
    } finally {
      queue.owners--;
      releaseQueue();
    }
  }

  function releaseQueue(): void {
    if (queue.owners === 0 && queue.active === 0 && sessionQueues.get(sessionId) === queue)
      sessionQueues.delete(sessionId);
  }

  function isBusy(): boolean {
    return queue.active > 0;
  }

  return { ensure, close, isBusy };
}

function failedMessage(
  model: Model<Api>,
  error: unknown,
  stopReason: "error" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason,
    errorMessage: `recontext: ${error instanceof Error ? error.message : String(error)}`,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    function onAbort() {
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
