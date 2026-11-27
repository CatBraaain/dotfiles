import { stat } from "node:fs/promises";
import { flattenPiMuxSessions, type PiMuxHistoryEntry, type PiMuxWorkspace } from "./pi-mux";

/** One Pi session as listed by the extension. */
export interface SessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  displayName: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/** Whether a saved session file still exists and is a regular file. */
export async function sessionFileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function listSessionSnapshot(
  history: readonly PiMuxHistoryEntry[],
  workspaces: readonly PiMuxWorkspace[],
) {
  return projectSessionSnapshot(history, workspaces);
}

export function projectSessionSnapshot(
  history: readonly PiMuxHistoryEntry[],
  workspaces: readonly PiMuxWorkspace[],
) {
  const registeredCwds = workspaces.map(({ cwd }) => cwd);
  const registered = new Set(registeredCwds);
  const archiveHistory = new Map<string, PiMuxHistoryEntry>();
  const summaries = new Map<string, SessionSummary>();
  for (const entry of history) {
    if (!registered.has(entry.cwd)) continue;
    if (entry.source === "live-archive") {
      archiveHistory.set(entry.id, entry);
      continue;
    }
    summaries.set(entry.id, {
      sessionId: entry.id,
      filePath: entry.file,
      cwd: entry.cwd,
      displayName: entry.title ?? "Untitled",
      createdAtMs: entry.btime,
      updatedAtMs: entry.mtime,
    });
  }
  const live = flattenPiMuxSessions(workspaces);
  for (const session of live) {
    const archived = archiveHistory.get(session.id);
    const matchingArchive = archived?.file === session.file ? archived : undefined;
    const saved = summaries.get(session.id);
    summaries.set(session.id, {
      sessionId: session.id,
      cwd: session.cwd,
      filePath: session.file,
      displayName: session.title || (saved?.displayName ?? matchingArchive?.title ?? "Untitled"),
      createdAtMs: saved?.createdAtMs ?? matchingArchive?.btime ?? null,
      updatedAtMs: saved?.updatedAtMs ?? matchingArchive?.mtime ?? null,
    });
  }
  const normalIds = new Set(live.filter((session) => !session.temporary).map(({ id }) => id));
  const sessions = [...summaries.values()];
  return {
    sessions,
    registeredCwds,
    inactiveIds: new Set(
      sessions
        .filter(({ sessionId }) => !normalIds.has(sessionId))
        .map(({ sessionId }) => sessionId),
    ),
  };
}
