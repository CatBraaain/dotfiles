// Pure helpers for the client-facing state route. The browser half polls the
// current agent/class of one session through an exact `/api` Fetch route
// (POST; same trust + browser-auth fence as the shared RPC channel);
// these functions define the wire payload and are shared by both halves.
// Kept free of dsh types so the adjacent test runs without them.

/** Absolute path this plugin claims on the `/api` channel (state read). */
export const AGENTS_STATE_PATH = "/api/dsh-agents/state";

/** Absolute path this plugin claims on the `/api` channel (selection write). */
export const AGENTS_SELECT_PATH = "/api/dsh-agents/select";

/** The selectable vocabulary the selector menus list (agents.yaml keys). */
export interface SelectionChoices {
  readonly agents: readonly string[];
  readonly classes: readonly string[];
}

/**
 * Wire payload of the state route: the display state of one session.
 * Unmanaged means the session has no display state (inert config, foreign
 * agent, or a one-shot child, whether running or disposed).
 */
export type AgentStatePayload =
  | { readonly managed: false }
  | {
      readonly managed: true;
      /** Active agents.yaml agent name. */
      readonly agent: string;
      /** Effective model class shown next to the agent name. */
      readonly className: string;
      /** True while a manual /model pick suspends auto routing. */
      readonly manual: boolean;
      /** Model of the resolved route; omitted before the first resolution. */
      readonly model?: string;
      /** agents.yaml agent names for the selector menu. */
      readonly agents: readonly string[];
      /** Class names for the selector menu. */
      readonly classes: readonly string[];
    };

/** Request payload: the session whose display state to read. */
export interface StateRequest {
  readonly sessionId?: string;
}

/** Validate the request payload; undefined for a malformed one. */
export function parseStateRequest(payload: unknown): StateRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { sessionId } = payload as { sessionId?: unknown };
  if (sessionId !== undefined && typeof sessionId !== "string") return undefined;
  return { sessionId };
}

/** Which selector a menu pick applies: the agent seat or the class seat. */
export type SelectKind = "agent" | "class";

/** Request payload: the selection to apply to one session. */
export interface SelectRequest {
  readonly sessionId?: string;
  readonly kind: SelectKind;
  readonly name: string;
}

/** Validate the selection payload; undefined for a malformed one. */
export function parseSelectRequest(payload: unknown): SelectRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { sessionId, kind, name } = payload as Record<string, unknown>;
  if (sessionId !== undefined && typeof sessionId !== "string") return undefined;
  if (kind !== "agent" && kind !== "class") return undefined;
  if (typeof name !== "string" || name === "") return undefined;
  return { sessionId, kind, name };
}

/** Outcome of a selection, shared by the commands and the select route. */
export interface SelectOutcome {
  readonly ok: boolean;
  readonly text: string;
}

/** Structural slice of a live agent the display filter needs; dsh-type free. */
export interface DisplayCandidateAgent {
  readonly session: { readonly header: { readonly origin?: string } };
}

/**
 * Display is a root-agent-only concern: spawnSubagent transiently registers
 * one-shot children in the routing state, but a child session never shows
 * agent/class (SPEC: unmanaged sessions display nothing).
 */
export function isDisplayedAgent(agent: DisplayCandidateAgent): boolean {
  return agent.session.header.origin !== "subagent";
}

/** Structural slice of a durable/live session header the root check needs; dsh-type free. */
export interface RootSessionHeader {
  readonly origin?: string;
  readonly delegationDepth?: number;
}

/**
 * Top-level sessions are the display's idle fallback: origin 'subagent' marks
 * a child, and delegationDepth > 0 is a child even without the origin tag
 * (the durable header persists the depth for the recursion budget).
 */
export function isRootSessionHeader(header: RootSessionHeader): boolean {
  return header.origin !== "subagent" && (header.delegationDepth ?? 0) === 0;
}

/** The per-agent state facts the display needs, keyed by session. */
export interface ManagedStateEntry {
  readonly sessionId: string;
  readonly agentName: string;
  readonly effectiveClass: string;
  readonly manualSelect: boolean;
  /** Model of the route resolved by the most recent request; omitted before any. */
  readonly model?: string;
}

/** The agent/class a session runs with before its first turn (config defaults). */
export interface InitialDisplay {
  readonly agent: string;
  readonly className: string;
}

/**
 * Build the display payload for one session. Live agents win; otherwise a
 * known top-level session shows the initial agent/class: dsh resumes an agent
 * lazily on first use, so an idle session has no live agent yet while its
 * first turn would still run the initial agent/class.
 */
export function buildStatePayload(
  entries: readonly ManagedStateEntry[],
  rootSessionIds: ReadonlySet<string>,
  initial: InitialDisplay,
  choices: SelectionChoices,
  sessionId: string | undefined,
): AgentStatePayload {
  if (sessionId === undefined) return { managed: false };
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  if (entry) {
    return {
      managed: true,
      agent: entry.agentName,
      className: entry.effectiveClass,
      manual: entry.manualSelect,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      agents: choices.agents,
      classes: choices.classes,
    };
  }
  if (rootSessionIds.has(sessionId)) {
    return {
      managed: true,
      agent: initial.agent,
      className: initial.className,
      manual: false,
      agents: choices.agents,
      classes: choices.classes,
    };
  }
  return { managed: false };
}
