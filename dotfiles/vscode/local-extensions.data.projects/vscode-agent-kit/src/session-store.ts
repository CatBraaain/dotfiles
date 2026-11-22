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

/**
 * Snapshot of the session list: live sessions from `pi-mux list` merged over
 * saved conversations from `pi-mux history`. Live entries win on conflicts.
 * A session counts as archived when no normal live Pi carries its ID.
 */
export async function listSessionSnapshot(
  history: readonly PiMuxHistoryEntry[],
  workspaces: readonly PiMuxWorkspace[],
) {
  const registeredCwds = workspaces.map(({ cwd }) => cwd);
  const registered = new Set(registeredCwds);
  const savedEntries = history.filter((entry) => registered.has(entry.cwd));
  const summaries = new Map<string, SessionSummary>();
  for (const entry of savedEntries) {
    summaries.set(entry.id, {
      sessionId: entry.id,
      filePath: entry.file,
      cwd: entry.cwd,
      displayName: entry.title ?? "Untitled",
      createdAtMs: entry.btime,
      updatedAtMs: entry.mtime,
    });
  }
  for (const session of flattenPiMuxSessions(workspaces)) {
    const saved = summaries.get(session.id);
    summaries.set(session.id, {
      sessionId: session.id,
      cwd: session.cwd,
      filePath: session.file,
      displayName:
        session.title !== null && session.title !== ""
          ? session.title
          : (saved?.displayName ?? "Untitled"),
      createdAtMs: saved?.createdAtMs ?? null,
      updatedAtMs: saved?.updatedAtMs ?? null,
    });
  }
  const normalIds = new Set(
    flattenPiMuxSessions(workspaces)
      .filter((session) => !session.temporary)
      .map(({ id }) => id),
  );
  const sessions = [...summaries.values()];
  return {
    sessions,
    registeredCwds,
    archivedIds: new Set(
      sessions
        .filter(({ sessionId }) => !normalIds.has(sessionId))
        .map(({ sessionId }) => sessionId),
    ),
  };
}
