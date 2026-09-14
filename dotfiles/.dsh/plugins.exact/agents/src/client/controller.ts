/** Poll the host for the agent/class state; kept react-free for unit tests. */
import type { AgentDisplayState } from "./format";

/** Host-facing callbacks and clock, injectable for tests. */
export interface StatePollerDeps {
  /** Fetch the current display state from the host. */
  readonly fetchState: () => Promise<AgentDisplayState>;
  /** Receive every successful fetch. */
  readonly onState: (state: AgentDisplayState) => void;
  readonly setInterval: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  /** Shared reader used by menu refreshes to reject stale poll responses. */
  readonly reader?: StateReader;
}

/** A state reader that rejects stale responses from older refreshes. */
export interface StateReader {
  readonly refresh: () => Promise<void>;
  readonly invalidate: () => void;
}

export function createStateReader(
  fetchState: () => Promise<AgentDisplayState>,
  onState: (state: AgentDisplayState) => void,
): StateReader {
  let latestRequest = 0;
  return {
    invalidate(): void {
      latestRequest++;
    },
    async refresh(): Promise<void> {
      const request = ++latestRequest;
      try {
        const state = await fetchState();
        if (request === latestRequest) onState(state);
      } catch {
        // Keep the last known state; the next refresh retries.
      }
    },
  };
}

/**
 * Fetch once immediately, then on every interval tick. Failures keep the last
 * known state and swallow the error (the next tick retries), so a brief
 * disconnect or reconnect never blanks the display. Returns the stop function.
 */
export function startStatePoller(intervalMs: number, deps: StatePollerDeps): () => void {
  let stopped = false;
  const reader =
    deps.reader ??
    createStateReader(deps.fetchState, (state) => {
      if (!stopped) deps.onState(state);
    });
  const poll = async (): Promise<void> => {
    if (stopped) return;
    await reader.refresh();
  };
  void poll();
  const handle = deps.setInterval(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    reader.invalidate();
    deps.clearInterval(handle);
  };
}
