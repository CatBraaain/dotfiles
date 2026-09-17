/**
 * Abort the agent turn when the LLM stream goes silent.
 *
 * pi's httpIdleTimeoutMs only covers request start → response headers (the
 * OpenAI SDK clears that timeout once headers arrive), so a stream that opens
 * successfully and then never sends a chunk stalls the session forever. This
 * extension arms a fixed 5-minute timer at every provider request and resets
 * it on each streaming delta; when it fires, the turn is aborted via
 * ctx.abort().
 * 詳細は ./SPEC.md。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Silence threshold since the last stream activity. Owner-fixed at 5 minutes. */
export const IDLE_TIMEOUT_MS = 300_000;

/** Real timer backend: schedule onFire, return its cancel function. */
export function realArmIdleTimer(ms: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, ms);
  return () => clearTimeout(timer);
}

// Test seam: swap out the real timer so tests never wait minutes. Same
// pattern as concurrency-retry's __sleep / __random.
export const __armIdleTimer: {
  current: (ms: number, onFire: () => void) => () => void;
} = { current: realArmIdleTimer };

let cancelTimer: (() => void) | undefined;

function stopTimer(): void {
  cancelTimer?.();
  cancelTimer = undefined;
}

function restartTimer(abort: () => void): void {
  stopTimer();
  cancelTimer = __armIdleTimer.current(IDLE_TIMEOUT_MS, () => {
    cancelTimer = undefined;
    abort();
  });
}

export default function streamIdleTimeoutExtension(pi: ExtensionAPI): void {
  // Arm at request start, so a stall before the first delta (headers arrived,
  // no chunks yet) is also covered.
  pi.on("before_provider_request", (_event, ctx) => restartTimer(() => ctx.abort()));
  // message_update fires only for assistant streaming deltas.
  pi.on("message_update", (_event, ctx) => restartTimer(() => ctx.abort()));
  // Stops on every message_end (assistant finalization in-flight; user and
  // toolResult ends only fire between requests). Tool execution and other
  // waits therefore do not count toward the timeout.
  pi.on("message_end", () => stopTimer());
}

/** Reset module state between tests. */
export function __resetIdleTimerState(): void {
  stopTimer();
}
