/** Poll the host for the agent/class state; kept react-free for unit tests. */
import type { AgentDisplayState } from './format'

/** Host-facing callbacks and clock, injectable for tests. */
export interface StatePollerDeps {
  /** Fetch the current display state from the host. */
  readonly fetchState: () => Promise<AgentDisplayState>
  /** Receive every successful fetch. */
  readonly onState: (state: AgentDisplayState) => void
  readonly setInterval: (callback: () => void, intervalMs: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

/**
 * Fetch once immediately, then on every interval tick. Failures keep the last
 * known state and swallow the error (the next tick retries), so a brief
 * disconnect or reconnect never blanks the display. Returns the stop function.
 */
export function startStatePoller(intervalMs: number, deps: StatePollerDeps): () => void {
  let stopped = false
  const poll = async (): Promise<void> => {
    if (stopped) return
    try {
      const state = await deps.fetchState()
      if (!stopped) deps.onState(state)
    } catch {
      // Keep the last known state; the next tick retries.
    }
  }
  void poll()
  const handle = deps.setInterval(() => void poll(), intervalMs)
  return () => {
    stopped = true
    deps.clearInterval(handle)
  }
}
