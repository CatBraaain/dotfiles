import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GuardedToolContext } from "../guardrails/api.ts";

const REQUEST_TIMEOUT_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
const REGISTRY_KEY = Symbol.for("pi.tools.background-bash.v1");

type RuntimeContext = { modelRegistry: object };
export type BackgroundBashContext = RuntimeContext &
  Pick<GuardedToolContext, "model" | "thinkingLevel" | "sessionManager">;

export interface BackgroundBashRequest {
  id: string;
  params: { command: string; timeout?: number };
  context: BackgroundBashContext;
  signal?: AbortSignal;
}

export type BackgroundBashOutcome =
  | { status: "completed"; result: AgentToolResult<unknown> }
  | { status: "failed"; error: unknown }
  | { status: "aborted"; reason: unknown }
  | { status: "unavailable"; error: Error };

export type TrackedBackgroundBashOutcome = BackgroundBashOutcome & {
  executionSettled: Promise<void>;
};

type BackgroundBashResult = BackgroundBashOutcome;

interface BackgroundBashAPI {
  execute(request: BackgroundBashRequest): Promise<TrackedBackgroundBashOutcome>;
  dispose(): void;
}

const shared = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: WeakMap<object, BackgroundBashAPI>;
};
const registry = (shared[REGISTRY_KEY] ??= new WeakMap<object, BackgroundBashAPI>());

export function requestBackgroundBash(
  request: BackgroundBashRequest,
): Promise<TrackedBackgroundBashOutcome> {
  if (request.signal?.aborted)
    return Promise.resolve(settledExecution({ status: "aborted", reason: request.signal.reason }));
  try {
    const api = registry.get(request.context.modelRegistry);
    return api
      ? api.execute(request)
      : Promise.resolve(unavailable("No active background Bash API"));
  } catch (error) {
    return Promise.resolve(unavailable("Background Bash runtime is unavailable", error));
  }
}

export function registerBackgroundBash(
  context: RuntimeContext,
  execute: (request: BackgroundBashRequest) => Promise<AgentToolResult<unknown>>,
  assertRuntimeActive: () => void,
): () => void {
  const key = context.modelRegistry;
  const pending = new Set<
    (result: BackgroundBashResult, abortStartedExecution?: boolean) => void
  >();
  let active = true;
  const api: BackgroundBashAPI = {
    execute(request) {
      if (!active) return Promise.resolve(unavailable("Background Bash API stopped"));
      try {
        assertRuntimeActive();
      } catch (error) {
        return Promise.resolve(unavailable("Background Bash runtime is unavailable", error));
      }
      return new Promise((resolveOutcome) => {
        const controller = new AbortController();
        let settled = false;
        let started = false;
        const execution = Promise.withResolvers<void>();
        const executionSettled = execution.promise;
        const timeoutSeconds = request.params?.timeout;
        const executionTimeoutSeconds =
          typeof timeoutSeconds === "number" &&
          Number.isFinite(timeoutSeconds) &&
          timeoutSeconds > 0
            ? timeoutSeconds
            : undefined;
        const timeoutMs =
          executionTimeoutSeconds !== undefined
            ? executionTimeoutSeconds * 1_000 + REQUEST_TIMEOUT_MS
            : REQUEST_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        let timer: ReturnType<typeof setTimeout>;

        function armTimeout(): void {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            finish({ status: "failed", error: new Error("Background Bash request timed out") });
            return;
          }
          timer = setTimeout(
            () => {
              if (Date.now() < deadline) armTimeout();
              else
                finish({ status: "failed", error: new Error("Background Bash request timed out") });
            },
            Math.min(remainingMs, MAX_TIMER_MS),
          );
        }

        armTimeout();

        function finish(result: BackgroundBashResult, abortStartedExecution = false): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(finish);
          if (!started) settleExecution();
          else if (abortStartedExecution || executionTimeoutSeconds === undefined)
            controller.abort();
          resolveOutcome({ ...result, executionSettled });
        }

        function settleExecution(): void {
          request.signal?.removeEventListener("abort", onAbort);
          execution.resolve();
        }

        function onAbort(): void {
          controller.abort();
          finish({ status: "aborted", reason: request.signal!.reason }, true);
        }

        pending.add(finish);
        request.signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => {
            if (settled) return;
            try {
              assertRuntimeActive();
            } catch (error) {
              finish(unavailableResult("Background Bash runtime is unavailable", error));
              return;
            }
            started = true;
            return execute({ ...request, signal: controller.signal });
          })
          .then(
            (result) => {
              settleExecution();
              finish(
                result && Array.isArray(result.content)
                  ? { status: "completed", result }
                  : { status: "failed", error: new Error("Invalid background Bash result") },
              );
            },
            (error) => {
              settleExecution();
              finish({ status: "failed", error });
            },
          );
      });
    },
    dispose() {
      if (!active) return;
      active = false;
      if (registry.get(key) === api) registry.delete(key);
      for (const finish of pending) finish(unavailableResult("Background Bash API stopped"));
      pending.clear();
    },
  };
  registry.get(key)?.dispose();
  registry.set(key, api);
  return api.dispose;
}

function settledExecution(result: BackgroundBashResult): TrackedBackgroundBashOutcome {
  return { ...result, executionSettled: Promise.resolve() };
}

function unavailable(message: string, cause?: unknown): TrackedBackgroundBashOutcome {
  return settledExecution({
    status: "unavailable",
    error: new Error(message, { cause }),
  });
}

function unavailableResult(message: string, cause?: unknown): BackgroundBashResult {
  return { status: "unavailable", error: new Error(message, { cause }) };
}
