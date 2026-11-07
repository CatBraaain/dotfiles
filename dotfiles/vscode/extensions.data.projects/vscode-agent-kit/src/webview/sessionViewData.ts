import { cwdGroupKey, groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import type { WebviewSessionGroup } from "./protocol";

/** Store-derived state the view projects: the registered workspace cwds whose
 * groups the list shows, the workspace cwds toggled off for the default view,
 * the active whitelist, the locked set, and inactive sessions' archived rows. */
export interface SessionViewInput {
  registeredCwds: readonly string[];
  hiddenWorkspaceCwds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  lockedIds: ReadonlySet<string>;
}

/** Convert scanned sessions into display-only data: only groups of registered
 * workspaces appear in the view (the list is a whitelist), and sessionless
 * registered workspaces keep an empty group. The workspace entry's view
 * toggle (`workspaceActive`) travels along so the client can hide the group
 * in the default view. */
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
      registered: registeredKeys.has(cwdGroupKey(group.cwd)),
      workspaceActive: !view.hiddenWorkspaceCwds.has(cwdGroupKey(group.cwd)),
      sessions: group.sessions.map((session) => ({
        sessionId: session.sessionId,
        displayName: session.displayName,
        mtimeMs: session.mtimeMs,
        isArchived: view.archivedIds.has(session.sessionId),
        isLocked: view.lockedIds.has(session.sessionId),
      })),
    }));
}
