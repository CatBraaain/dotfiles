/** Display state carried from the host by the `dsh-agents/state` route. */
export interface AgentDisplayState {
  readonly managed: boolean;
  readonly agent?: string;
  readonly className?: string;
  readonly manual?: boolean;
  readonly model?: string;
  readonly agents?: readonly string[];
  readonly classes?: readonly string[];
}

/** The unmanaged baseline: the display renders nothing. */
export const UNMANAGED_STATE: AgentDisplayState = { managed: false };

/**
 * The agent row's trigger label: `🤖 agent: <name>`. Undefined for an
 * unmanaged session (the row does not render).
 */
export function agentLineLabel(state: AgentDisplayState): string | undefined {
  if (!state.managed || state.agent === undefined) return undefined;
  return `🤖 agent: ${state.agent}`;
}

/**
 * The class row's trigger label: `💎 class: <name> (<mode>: <model>)` where
 * mode is `auto` or `manual` and the model is what the next request would
 * resolve to (auto) or the resolved route (manual) — omitted when neither is
 * available. Undefined when the managed state carries no class (the row does
 * not render).
 */
export function classLineLabel(state: AgentDisplayState): string | undefined {
  if (!state.managed || state.agent === undefined || state.className === undefined) {
    return undefined;
  }
  const mode = state.manual === true ? "manual" : "auto";
  const detail = state.model !== undefined ? `${mode}: ${state.model}` : mode;
  return `💎 class: ${state.className} (${detail})`;
}

/** Narrow a value into a readonly string array; undefined for anything else. */
function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

/** Narrow an untyped route payload into the display state (defensive). */
export function parseDisplayState(value: unknown): AgentDisplayState {
  if (typeof value !== "object" || value === null) return UNMANAGED_STATE;
  const { managed, agent, className, manual, model, agents, classes } = value as Record<
    string,
    unknown
  >;
  if (managed !== true || typeof agent !== "string" || agent === "") return UNMANAGED_STATE;
  const agentNames = stringArray(agents);
  const classNames = stringArray(classes);
  return {
    managed: true,
    agent,
    ...(typeof className === "string" && className !== "" ? { className } : {}),
    ...(manual === true ? { manual: true } : {}),
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    ...(agentNames !== undefined ? { agents: agentNames } : {}),
    ...(classNames !== undefined ? { classes: classNames } : {}),
  };
}
