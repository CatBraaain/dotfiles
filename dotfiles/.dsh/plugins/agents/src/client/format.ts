/** Display state carried from the host by the `dsh-agents/state` route. */
export interface AgentDisplayState {
  readonly managed: boolean;
  readonly agent?: string;
  readonly className?: string;
  readonly manual?: boolean;
}

/** The unmanaged baseline: the display renders nothing. */
export const UNMANAGED_STATE: AgentDisplayState = { managed: false };

/**
 * The pi widget lines: `🤖 agent: <name>` plus `💎 class: <name>` with a
 * `(manual)` suffix while a manual /model pick suspends routing. Empty for an
 * unmanaged session.
 */
export function agentStateLines(state: AgentDisplayState): readonly string[] {
  if (!state.managed || state.agent === undefined) return [];
  const lines = [`🤖 agent: ${state.agent}`];
  if (state.className !== undefined) {
    lines.push(`💎 class: ${state.className}${state.manual ? " (manual)" : ""}`);
  }
  return lines;
}

/** Narrow an untyped route payload into the display state (defensive). */
export function parseDisplayState(value: unknown): AgentDisplayState {
  if (typeof value !== "object" || value === null) return UNMANAGED_STATE;
  const { managed, agent, className, manual } = value as Record<string, unknown>;
  if (managed !== true || typeof agent !== "string" || agent === "") return UNMANAGED_STATE;
  return {
    managed: true,
    agent,
    ...(typeof className === "string" && className !== "" ? { className } : {}),
    ...(manual === true ? { manual: true } : {}),
  };
}
