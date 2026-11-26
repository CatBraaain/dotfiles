import { cwdGroupKey, groupSessions } from "../grouping";
import type { SessionSummary } from "../session-store";
import type { SessionPhase, WebviewSessionGroup } from "./protocol";

/** Store-derived state the view projects: the registered workspace cwds
 * (the `workspaces` keys) whose groups the list shows, the active whitelist,
 * and the live phases of running sessions. */
export interface SessionViewInput {
  registeredCwds: readonly string[];
  archivedIds: ReadonlySet<string>;
  liveIds?: ReadonlySet<string>;
  phases: ReadonlyMap<string, SessionPhase>;
  unreadIds?: ReadonlySet<string>;
  /** Sessions whose state publication is known to be incomplete. */
  delayedIds?: ReadonlySet<string>;
  reloadPendingIds?: ReadonlySet<string>;
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
        updatedAtMs: session.updatedAtMs,
        isArchived: view.archivedIds.has(session.sessionId),
        ...(view.liveIds?.has(session.sessionId) ? { isLive: true } : {}),
        state: view.phases.get(session.sessionId),
        hasUnread: view.unreadIds?.has(session.sessionId) ?? false,
        publishDelayed: view.delayedIds?.has(session.sessionId) ?? false,
        ...(view.reloadPendingIds?.has(session.sessionId) ? { reloadPending: true } : {}),
      })),
    }));
}
