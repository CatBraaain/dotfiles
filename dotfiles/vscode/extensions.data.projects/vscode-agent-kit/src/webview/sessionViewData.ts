import { cwdGroupKey, groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import type { WebviewSessionGroup } from "./protocol";

/** Convert scanned sessions into display-only data: only groups of registered
 * workspaces appear in the view (the list is a whitelist), and sessionless
 * registered workspaces keep an empty group. */
export function sessionViewGroups(
  sessions: SessionSummary[],
  registeredCwds: readonly string[],
  archivedIds: ReadonlySet<string>,
  lockedIds: ReadonlySet<string>,
): WebviewSessionGroup[] {
  const registeredKeys = new Set(registeredCwds.map((cwd) => cwdGroupKey(cwd)));
  return groupSessions(sessions, registeredCwds)
    .filter((group) => registeredKeys.has(cwdGroupKey(group.cwd)))
    .map((group) => ({
      cwd: group.cwd,
      label: group.label,
      registered: registeredKeys.has(cwdGroupKey(group.cwd)),
      sessions: group.sessions.map((session) => ({
        sessionId: session.sessionId,
        displayName: session.displayName,
        mtimeMs: session.mtimeMs,
        isArchived: archivedIds.has(session.sessionId),
        isLocked: lockedIds.has(session.sessionId),
      })),
    }));
}
