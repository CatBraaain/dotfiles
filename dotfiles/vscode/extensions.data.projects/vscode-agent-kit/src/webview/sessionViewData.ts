import { groupSessions } from "../grouping";
import type { SessionSummary } from "../sessionStore";
import { visibleSessions, type ViewMode } from "../viewMode";
import type { WebviewSessionGroup } from "./protocol";

/** Convert scanned sessions into the display-only data sent to the webview. */
export function sessionViewGroups(
  sessions: SessionSummary[],
  mode: ViewMode,
  activeSessionIds: ReadonlySet<string>,
): WebviewSessionGroup[] {
  return groupSessions(visibleSessions(sessions, mode, activeSessionIds)).map((group) => ({
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
