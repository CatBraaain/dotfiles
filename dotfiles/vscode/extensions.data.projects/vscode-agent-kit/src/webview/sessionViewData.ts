import { cwdGroupKey, groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import type { WebviewSessionGroup } from "./protocol";

/** Store-derived state the view projects: the registered workspace cwds
 * (the `active-workspaces` keys) whose groups the list shows, the active
 * whitelist, and the locked set. */
export interface SessionViewInput {
  registeredCwds: readonly string[];
  archivedIds: ReadonlySet<string>;
  lockedIds: ReadonlySet<string>;
}

/** Convert scanned sessions into display-only data: only groups of registered
 * workspaces appear in the view, and sessionless registered workspaces keep
 * an empty group. */
export function sessionViewGroups(
  sessions: SessionSummary[],
  view: SessionViewInput,
): WebviewSessionGroup[] {
  const registeredKeys = new Set(view.registeredCwds.map((cwd) => cwdGroupKey(cwd)));
  return groupSessions(sessions, view.registeredCwds)
    .filter((group) => registeredKeys.has(cwdGroupKey(group.cwd)))
    .map((group) => ({
      cwd: group.cwd,
      label: group.label,
      sessions: group.sessions.map((session) => ({
        sessionId: session.sessionId,
        displayName: session.displayName,
        mtimeMs: session.mtimeMs,
        isArchived: view.archivedIds.has(session.sessionId),
        isLocked: view.lockedIds.has(session.sessionId),
      })),
    }));
}
