// Pure helpers for the client-facing state route. The browser half polls the
// current agent/class of one session through an exact `/api` Fetch route
// (POST; same trust + browser-auth fence as the shared RPC channel);
// these functions define the wire payload and are shared by both halves.
// Kept free of dsh types so the adjacent test runs without them.

/** Absolute path this plugin claims on the `/api` channel. */
export const AGENTS_STATE_PATH = "/api/dsh-agents/state";

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

/** The per-agent state facts the display needs, keyed by session. */
export interface ManagedStateEntry {
  readonly sessionId: string;
  readonly agentName: string;
  readonly effectiveClass: string;
  readonly manualSelect: boolean;
}

/** Build the display payload for one session: unmanaged when no live agent matches. */
export function buildStatePayload(
  entries: readonly ManagedStateEntry[],
  sessionId: string | undefined,
): AgentStatePayload {
  if (sessionId === undefined) return { managed: false };
  const entry = entries.find((candidate) => candidate.sessionId === sessionId);
  if (!entry) return { managed: false };
  return {
    managed: true,
    agent: entry.agentName,
    className: entry.effectiveClass,
    manual: entry.manualSelect,
  };
}
