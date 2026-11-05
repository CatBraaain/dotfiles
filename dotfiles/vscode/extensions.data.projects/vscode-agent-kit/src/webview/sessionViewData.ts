import { groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import type { WebviewSessionGroup } from "./protocol";

/** Convert scanned sessions into display-only data: every session of every cwd
 * group, plus sessionless groups for registered workspaces. */
export function sessionViewGroups(
  sessions: SessionSummary[],
  registeredCwds: readonly string[],
  archivedIds: ReadonlySet<string>,
  lockedIds: ReadonlySet<string>,
): WebviewSessionGroup[] {
  return groupSessions(sessions, registeredCwds).map((group) => ({
    cwd: group.cwd,
    label: group.label,
    sessions: group.sessions.map((session) => ({
      sessionId: session.sessionId,
      displayName: session.displayName,
      mtimeMs: session.mtimeMs,
      isArchived: archivedIds.has(session.sessionId),
      isLocked: lockedIds.has(session.sessionId),
    })),
  }));
}
