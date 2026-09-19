import type { SessionSummary } from "./sessionStore";

/** Sidebar display mode: only active sessions, or all sessions. */
export type ViewMode = "active" | "all";

/**
 * Sessions visible in the tree for a display mode:
 * "active" keeps only sessions marked active, "all" keeps every session.
 */
export function visibleSessions(sessions: SessionSummary[], mode: ViewMode, activeIds: ReadonlySet<string>): SessionSummary[] {
  return mode === "active" ? sessions.filter((session) => activeIds.has(session.sessionId)) : sessions;
}
