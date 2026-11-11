import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GuardedToolContext } from "../guardrails/api.ts";

const REQUEST_TIMEOUT_MS = 2_000;
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

interface BackgroundBashAPI {
  execute(request: BackgroundBashRequest): Promise<BackgroundBashOutcome>;
  dispose(): void;
}

const shared = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: WeakMap<object, BackgroundBashAPI>;
};
const registry = (shared[REGISTRY_KEY] ??= new WeakMap<object, BackgroundBashAPI>());

export function requestBackgroundBash(
  request: BackgroundBashRequest,
): Promise<BackgroundBashOutcome> {
  if (request.signal?.aborted)
    return Promise.resolve({ status: "aborted", reason: request.signal.reason });
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
  const pending = new Set<(outcome: BackgroundBashOutcome) => void>();
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
        const timer = setTimeout(
          () => finish({ status: "failed", error: new Error("Background Bash request timed out") }),
          Math.max(REQUEST_TIMEOUT_MS, (request.params?.timeout ?? 0) * 1_000),
        );

        function finish(outcome: BackgroundBashOutcome): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          pending.delete(finish);
          if (outcome.status !== "completed") controller.abort();
          resolveOutcome(outcome);
        }

        function onAbort(): void {
          finish({ status: "aborted", reason: request.signal!.reason });
        }

        pending.add(finish);
        request.signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => {
            if (settled) return;
            try {
              assertRuntimeActive();
            } catch (error) {
              finish(unavailable("Background Bash runtime is unavailable", error));
              return;
            }
            return execute({ ...request, signal: controller.signal });
          })
          .then(
            (result) => {
              if (settled) return;
              finish(
                result && Array.isArray(result.content)
                  ? { status: "completed", result }
                  : { status: "failed", error: new Error("Invalid background Bash result") },
              );
            },
            (error) => finish({ status: "failed", error }),
          );
      });
    },
    dispose() {
      if (!active) return;
      active = false;
      if (registry.get(key) === api) registry.delete(key);
      for (const finish of pending) finish(unavailable("Background Bash API stopped"));
      pending.clear();
    },
  };
  registry.get(key)?.dispose();
  registry.set(key, api);
  return api.dispose;
}

function unavailable(message: string, cause?: unknown): BackgroundBashOutcome {
  return { status: "unavailable", error: new Error(message, { cause }) };
}
