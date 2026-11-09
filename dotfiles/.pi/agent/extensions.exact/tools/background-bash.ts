import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardedToolContext } from "../guardrails/api.ts";

const EXECUTE_BASH = "tools:execute-bash";
const REQUEST_TIMEOUT_MS = 2_000;
type Events = ExtensionAPI["events"];

export type BackgroundBashContext = Pick<
  GuardedToolContext,
  "model" | "thinkingLevel" | "sessionManager"
>;

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

interface BashClaim {
  request: BackgroundBashRequest;
  finish(outcome: BackgroundBashOutcome): void;
}

interface BashEvent {
  claim(): BashClaim | undefined;
}

export function requestBackgroundBash(
  events: Events,
  request: BackgroundBashRequest,
): Promise<BackgroundBashOutcome> {
  if (request.signal?.aborted)
    return Promise.resolve({ status: "aborted", reason: request.signal.reason });
  return new Promise((resolveOutcome) => {
    const controller = new AbortController();
    let settled = false;
    let claimed = false;
    let emitting = true;
    const timer = setTimeout(
      () => finish({ status: "failed", error: new Error("Background Bash request timed out") }),
      REQUEST_TIMEOUT_MS,
    );

    function finish(outcome: BackgroundBashOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (outcome.status !== "completed") controller.abort();
      resolveOutcome(outcome);
    }

    function onAbort(): void {
      finish({ status: "aborted", reason: request.signal!.reason });
    }

    request.signal?.addEventListener("abort", onAbort, { once: true });
    const event: BashEvent = {
      claim() {
        if (!emitting || claimed || settled) return undefined;
        claimed = true;
        return { request: { ...request, signal: controller.signal }, finish };
      },
    };
    try {
      events.emit(EXECUTE_BASH, event);
    } catch (error) {
      finish({ status: "failed", error });
    } finally {
      emitting = false;
    }
    if (!claimed)
      finish({ status: "unavailable", error: new Error("No active background Bash receiver") });
  });
}

export function registerBackgroundBash(
  events: Events,
  execute: (request: BackgroundBashRequest) => Promise<AgentToolResult<unknown>>,
): () => void {
  const pending = new Set<BashClaim>();
  let active = true;
  const unsubscribe = events.on(EXECUTE_BASH, (data) => {
    if (!active || !data || typeof (data as BashEvent).claim !== "function") return;
    const claim = (data as BashEvent).claim();
    if (!claim) return;
    pending.add(claim);
    const signal = claim.request.signal!;
    function removePending(): void {
      pending.delete(claim!);
      signal.removeEventListener("abort", removePending);
    }
    signal.addEventListener("abort", removePending, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return execute(claim.request);
      })
      .then(
        (result) => {
          removePending();
          claim.finish(
            result && Array.isArray(result.content)
              ? { status: "completed", result }
              : { status: "failed", error: new Error("Invalid background Bash result") },
          );
        },
        (error) => {
          removePending();
          claim.finish({ status: "failed", error });
        },
      );
  });
  return function dispose(): void {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const claim of pending)
      claim.finish({ status: "unavailable", error: new Error("Background Bash receiver stopped") });
    pending.clear();
  };
}
