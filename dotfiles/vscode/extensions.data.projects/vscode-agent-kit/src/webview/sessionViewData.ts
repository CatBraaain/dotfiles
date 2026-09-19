import { groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import type { WebviewSessionGroup } from "./protocol";

/** Convert scanned sessions into display-only data: every session of every cwd group. */
export function sessionViewGroups(
  sessions: SessionSummary[],
  activeSessionIds: ReadonlySet<string>,
): WebviewSessionGroup[] {
  return groupSessions(sessions).map((group) => ({
    cwd: group.cwd,
    label: group.label,
    sessions: group.sessions.map((session) => ({
      sessionId: session.sessionId,
      displayName: session.displayName,
      mtimeMs: session.mtimeMs,
      isActive: activeSessionIds.has(session.sessionId),
    })),
  }));
}
