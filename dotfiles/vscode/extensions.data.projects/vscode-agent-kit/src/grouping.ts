import type { SessionSummary } from "./sessionStore";

/** A cwd group of sessions, sorted by mtime (newest first). */
export interface SessionGroup {
  cwd: string;
  label: string;
  sessions: SessionSummary[];
}

/** Short label for a cwd: its basename ("/" itself stays "/"). */
export function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (trimmed === "") return cwd; // root path such as "/"
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Group sessions by cwd.
 * - Groups are ordered by their newest session mtime, descending.
 * - Sessions within a group are ordered by mtime, descending.
 * Ties break deterministically (sessionId / cwd ascending).
 */
export function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const list = byCwd.get(session.cwd);
    if (list === undefined) {
      byCwd.set(session.cwd, [session]);
    } else {
      list.push(session);
    }
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || compareString(a.sessionId, b.sessionId));
    groups.push({ cwd, label: cwdLabel(cwd), sessions: list });
  }
  groups.sort((a, b) => {
    const newest = (group: SessionGroup) => group.sessions[0]?.mtimeMs ?? Number.NEGATIVE_INFINITY;
    return newest(b) - newest(a) || compareString(a.cwd, b.cwd);
  });
  return groups;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
