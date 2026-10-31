import {
  createAssistantMessageEventStream,
  InMemoryModelsStore,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type Credential,
  type CredentialStore,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { SUMMARY_INSTRUCTION } from "./auto-compaction.ts";
import { installProviderGates } from "./provider-gate.ts";

export interface Capture {
  kind: "summary" | "normal";
  model: Model<Api>;
  context: TranscriptContext;
  options: SimpleStreamOptions;
}

type TerminalReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export function fakeProvider(
  providerId = "memory-compaction",
  overrides: Partial<Model<Api>> = {},
) {
  const state = {
    models: [fakeModel({ provider: providerId, ...overrides })],
    pendingModels: undefined as Model<Api>[] | undefined,
    requests: [] as Capture[],
    timeline: [] as string[],
    callbacks: [] as string[],
    active: 0,
    maxActive: 0,
    summaryText: "Saved goals and pending work.",
    summaryReason: "stop" as TerminalReason,
    normalReason: "stop" as TerminalReason,
    normalContent: undefined as AssistantMessage["content"] | undefined,
    authRevision: "synthetic-v1",
    beforeReply: undefined as ((capture: Capture) => Promise<void> | void) | undefined,
  };
  function stream(
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions = {},
  ) {
    const kind: Capture["kind"] =
      context.messages.at(-1)?.role === "user" &&
      context.messages.at(-1)?.content === SUMMARY_INSTRUCTION
        ? "summary"
        : "normal";
    const capture = { kind, model, context, options };
    state.requests.push(capture);
    state.timeline.push(`${kind}:start`);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const output = createAssistantMessageEventStream();
    async function finish() {
      try {
        await options.onPayload?.({ kind }, model);
        await options.onResponse?.(
          {
            status: kind === "summary" && state.summaryReason === "error" ? 429 : 200,
            headers: {},
          },
          model,
        );
        await options.onProviderStreamEvent?.({ kind }, model);
        await state.beforeReply?.(capture);
        const reason = options.signal?.aborted
          ? "aborted"
          : kind === "summary"
            ? state.summaryReason
            : state.normalReason;
        const message = assistant(
          model,
          kind === "summary" ? state.summaryText : "Normal reply",
          reason,
        );
        if (kind === "normal" && state.normalContent) message.content = state.normalContent;
        if (reason === "toolUse" && !state.normalContent)
          message.content.push({
            type: "toolCall",
            id: "unexpected-tool",
            name: "never_execute",
            arguments: {},
          });
        if (reason === "error" || reason === "aborted") {
          message.errorMessage =
            kind === "summary" ? "Synthetic summary error 429" : "Synthetic normal error";
          output.push({ type: "error", reason, error: message });
        } else {
          output.push({ type: "start", partial: message });
          output.push({ type: "done", reason, message });
        }
        output.end();
      } catch (error) {
        const message = assistant(model, "", "error");
        message.errorMessage = String(error);
        output.push({ type: "error", reason: "error", error: message });
        output.end();
      } finally {
        state.active--;
        state.timeline.push(`${kind}:end`);
      }
    }
    void finish();
    return output;
  }
  const provider: Provider = {
    id: providerId,
    name: "Memory provider",
    baseUrl: "https://fake.invalid/v1",
    auth: {
      apiKey: {
        name: "Synthetic auth",
        async check() {
          return { type: "api_key", source: "test" };
        },
        async resolve({ credential }) {
          return {
            auth: {
              apiKey: credential?.type === "api_key" ? credential.key : state.authRevision,
              headers: { "X-Auth-Revision": state.authRevision },
              baseUrl: "https://fake.invalid/v1",
            },
            source: "test",
          };
        },
      },
    },
    getModels() {
      return state.models;
    },
    async refreshModels(context) {
      if (!state.pendingModels) return;
      const models = state.pendingModels;
      state.pendingModels = undefined;
      await context.publish({
        update() {
          state.models = models;
        },
      });
    },
    stream<T extends Api>(
      model: Model<T>,
      context: TranscriptContext,
      options?: ApiStreamOptions<T>,
    ) {
      return stream(model, context, options as unknown as SimpleStreamOptions);
    },
    streamSimple: stream,
  };
  return { provider, state };
}

export function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "physical",
    name: "Memory model",
    provider: "memory-compaction",
    api: "openai-responses",
    baseUrl: "https://fake.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 12_000,
    maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function assistant(
  model = fakeModel(),
  text = "reply",
  stopReason: TerminalReason = "stop",
  timestamp = Date.now(),
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: text ? [{ type: "text", text }] : [],
    stopReason,
    timestamp,
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

export function seedConversation(manager: SessionManager, oldChars = 12_000) {
  const system = manager.appendMessage({
    role: "system",
    content: "Original system",
    toolsAdded: [{ name: "old_tool", description: "Old tool", parameters: {} }],
    timestamp: 1,
  });
  const old = manager.appendMessage({
    role: "user",
    content: "OLD " + "x".repeat(oldChars),
    timestamp: 2,
  });
  manager.appendMessage(assistant(undefined, "old answer" + "a".repeat(oldChars), "stop", 3));
  const recent = manager.appendMessage({ role: "user", content: "RECENT", timestamp: 4 });
  manager.appendMessage(assistant(undefined, "recent answer", "stop", 5));
  const pending = manager.appendMessage({ role: "user", content: "PENDING", timestamp: 6 });
  return { system, old, recent, pending };
}

export function memoryCredentials(): CredentialStore {
  const values = new Map<string, Credential>();
  return {
    async read(id) {
      return values.get(id);
    },
    async list() {
      return [...values].map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    async modify(id, update) {
      const value = await update(values.get(id));
      if (value) values.set(id, value);
      else values.delete(id);
      return value;
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

export async function memoryRuntime() {
  return ModelRuntime.create({
    credentials: memoryCredentials(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

export async function gateFixture(overrides: Partial<Model<Api>> = {}) {
  const runtime = await memoryRuntime();
  const fake = fakeProvider(undefined, overrides);
  runtime.registerNativeProvider(fake.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory("/tmp/work/dotfiles/cache-preserving-compaction-qa");
  const notices: string[] = [];
  const controller = new AbortController();
  const ctx = {
    modelRegistry: registry,
    sessionManager: manager,
    signal: controller.signal,
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events: createEventBus(),
    appendEntry(customType: string, data: unknown) {
      manager.appendCustomEntry(customType, data);
    },
    registerProvider(providerId: string | Provider, config?: never) {
      if (typeof providerId === "string") registry.registerProvider(providerId, config!);
      else registry.registerProvider(providerId);
    },
  } as unknown as ExtensionAPI;
  const gates = installProviderGates(pi, () => ctx);
  const model = runtime.getModel(fake.provider.id, "physical")!;
  return { ...fake, runtime, registry, manager, pi, ctx, gates, model, notices, controller };
}

export function commitDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]) {
  for (const draft of drafts) {
    if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
    if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
    if (draft.type === "custom_message")
      manager.appendCustomMessageEntry(
        draft.customType,
        draft.content,
        draft.display,
        draft.details,
      );
    if (draft.type === "compaction")
      manager.appendCompaction(
        draft.summary,
        draft.firstKeptEntryId,
        0,
        draft.details,
        true,
        draft.usage,
      );
  }
}
