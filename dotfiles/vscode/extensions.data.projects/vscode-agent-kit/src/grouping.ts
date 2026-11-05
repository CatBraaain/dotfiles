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

/** Grouping key for same-directory cwds. Trailing separators only: the
 * registered workspace cwds are already resolved paths (the extension host
 * normalizes them), and this module also runs in the browser stories where
 * node:path is unavailable. */
export function cwdGroupKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "");
}

/** Per-cwd accumulation while grouping; the display cwd comes from the first source. */
interface GroupAccumulator {
  cwd: string;
  sessions: SessionSummary[];
}

/**
 * Group sessions by cwd, adding a sessionless group for every registered
 * workspace cwd.
 * - Same-directory cwds that only differ in trailing separators are one group;
 *   the group keeps the display cwd of its first source.
 * - Groups are ordered by their newest session mtime, descending; groups
 *   without sessions go last. Sessions within a group are ordered by mtime,
 *   descending.
 * Ties break deterministically (sessionId / cwd ascending).
 */
export function groupSessions(
  sessions: SessionSummary[],
  registeredCwds: readonly string[] = [],
): SessionGroup[] {
  const byCwd = new Map<string, GroupAccumulator>();
  for (const session of sessions) {
    const key = cwdGroupKey(session.cwd);
    const accumulator = byCwd.get(key);
    if (accumulator === undefined) {
      byCwd.set(key, { cwd: session.cwd, sessions: [session] });
    } else {
      accumulator.sessions.push(session);
    }
  }
  for (const cwd of registeredCwds) {
    const key = cwdGroupKey(cwd);
    if (!byCwd.has(key)) byCwd.set(key, { cwd, sessions: [] });
  }
  const groups: SessionGroup[] = [];
  for (const accumulator of byCwd.values()) {
    accumulator.sessions.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || compareString(a.sessionId, b.sessionId),
    );
    groups.push({
      cwd: accumulator.cwd,
      label: cwdLabel(accumulator.cwd),
      sessions: accumulator.sessions,
    });
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
