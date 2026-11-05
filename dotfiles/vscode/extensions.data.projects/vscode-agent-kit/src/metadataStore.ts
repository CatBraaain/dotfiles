import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { errorMessage, isRecord } from "./guards";

/**
 * Metadata store for the Pi session manager extension.
 *
 * Pure Node.js module (no VS Code API) so the same read/write logic can be
 * reused from future clients (Web UI, CLI) and unit tested without VS Code.
 *
 * File shape (UTF-8 JSON, pretty printed):
 * {
 *   "version": 1,
 *   "sessions": {
 *     "<session-id>": { "active": false, "locked": true }
 *   }
 * }
 *
 * `active: false` marks a session as archived (explicit archive only; a
 * missing entry or flag means unarchived). `locked: true` protects a session
 * from being archived until it is unlocked.
 *
 * Unknown top-level keys and unknown per-session attributes are preserved on
 * rewrite. Concurrent writers follow last-write-wins semantics (each write is
 * a full-file atomic replace; there is no locking).
 */

/** Per-session metadata entry. Unknown attributes are preserved. */
export interface SessionMetadata {
  active?: boolean;
  [key: string]: unknown;
}

/** Registered workspace entry (New Workspace action). Unknown attributes are preserved. */
export interface WorkspaceMetadata {
  addedAtMs?: number;
  [key: string]: unknown;
}

/** Whole metadata store document. Unknown top-level keys are preserved. */
export interface MetadataStoreData {
  version?: number;
  sessions?: Record<string, SessionMetadata>;
  workspaces?: Record<string, WorkspaceMetadata>;
  [key: string]: unknown;
}

export type MetadataReadResult =
  /** File read and parsed successfully. */
  | { status: "ok"; data: MetadataStoreData }
  /** File does not exist: behave as if there is no metadata. */
  | { status: "empty" }
  /** Unreadable or unparseable: behave as no metadata, never write, surface the message. */
  | { status: "error"; message: string };

export type MetadataUpdateResult =
  | { ok: true; data: MetadataStoreData }
  | { ok: false; message: string };

/** Read the metadata store. Missing file => empty; unreadable/unparseable => error. */
export function readMetadataStore(path: string): MetadataReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "empty" };
    return { status: "error", message: `Cannot read ${basename(path)}: ${errorMessage(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "error",
      message: `${basename(path)} is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { status: "error", message: `${basename(path)} must contain a JSON object` };
  }
  if (parsed.sessions !== undefined && !isRecord(parsed.sessions)) {
    return { status: "error", message: `${basename(path)}: "sessions" must be a JSON object` };
  }
  if (parsed.workspaces !== undefined && !isRecord(parsed.workspaces)) {
    return { status: "error", message: `${basename(path)}: "workspaces" must be a JSON object` };
  }
  return { status: "ok", data: parsed };
}

/**
 * Atomically replace the metadata store file: write a temp file in the same
 * directory, then rename over the target. An interrupted write never leaves
 * the previous content half-written (rename is atomic on the same filesystem).
 * Throws on filesystem errors.
 */
export function writeMetadataStore(path: string, data: MetadataStoreData): void {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, json, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of the temp file; the original file is untouched.
    }
    throw error;
  }
}

/**
 * Read-modify-write session entries. `update` mutates the given `sessions`
 * map and returns whether anything changed; when it returns false no write
 * happens. Missing file: create the store fresh (version 1).
 * Unreadable/unparseable file or write failure: nothing is written,
 * `{ ok: false }` is returned so the caller can surface the error.
 * Unknown attributes, other sessions, and unknown top-level keys are
 * preserved.
 */
function updateSessions(
  path: string,
  update: (sessions: Record<string, SessionMetadata>) => boolean,
): MetadataUpdateResult {
  const read = readMetadataStore(path);
  if (read.status === "error") {
    return { ok: false, message: read.message };
  }
  const base: MetadataStoreData =
    read.status === "ok" ? structuredClone(read.data) : { version: 1, sessions: {} };
  const sessions: Record<string, SessionMetadata> = { ...base.sessions };
  if (!update(sessions)) {
    return { ok: true, data: read.status === "ok" ? read.data : base };
  }
  const next: MetadataStoreData = { ...base, sessions };
  if (next.version === undefined) {
    next.version = 1;
  }
  try {
    writeMetadataStore(path, next);
  } catch (error) {
    return { ok: false, message: `Failed to write ${basename(path)}: ${errorMessage(error)}` };
  }
  return { ok: true, data: next };
}

/**
 * Read-modify-write a single session's `active` flag (true = unarchived,
 * used when a session is opened or detected as new).
 */
export function setSessionActive(
  path: string,
  sessionId: string,
  active: boolean,
): MetadataUpdateResult {
  return updateSessions(path, (sessions) => {
    sessions[sessionId] = { ...sessions[sessionId], active };
    return true;
  });
}

/** Read-modify-write a single session's `locked` flag (archive protection). */
export function setSessionLocked(
  path: string,
  sessionId: string,
  locked: boolean,
): MetadataUpdateResult {
  return updateSessions(path, (sessions) => {
    sessions[sessionId] = { ...sessions[sessionId], locked };
    return true;
  });
}

/**
 * Archive the given sessions in one metadata write. Each session is checked
 * against the freshly read store: locked sessions are skipped, so a stale UI
 * or a direct message cannot archive them. Returns without writing when every
 * requested session is locked.
 */
export function archiveSessions(path: string, sessionIds: readonly string[]): MetadataUpdateResult {
  return updateSessions(path, (sessions) => {
    let archivedAny = false;
    for (const sessionId of sessionIds) {
      const entry = sessions[sessionId];
      if (isRecord(entry) && entry.locked) continue;
      sessions[sessionId] = { ...entry, active: false };
      archivedAny = true;
    }
    return archivedAny;
  });
}

/** Session IDs whose `active` attribute is explicitly false (missing/truthy = unarchived). */
export function archivedSessionIds(data: MetadataStoreData | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(data?.sessions ?? {})) {
    if (isRecord(entry) && entry.active === false) {
      ids.add(id);
    }
  }
  return ids;
}

/** Session IDs whose `locked` attribute is truthy. */
export function lockedSessionIds(data: MetadataStoreData | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(data?.sessions ?? {})) {
    if (isRecord(entry) && entry.locked) {
      ids.add(id);
    }
  }
  return ids;
}

export type RegisterWorkspaceResult = { ok: true; added: boolean } | { ok: false; message: string };

/**
 * Register a workspace cwd in the metadata store. The key is the resolved
 * absolute path; an existing entry pointing at the same directory is kept as
 * is (no rewrite). Missing file: create the store fresh (version 1).
 */
export function registerWorkspace(
  path: string,
  cwd: string,
  addedAtMs: number,
): RegisterWorkspaceResult {
  const read = readMetadataStore(path);
  if (read.status === "error") {
    return { ok: false, message: read.message };
  }
  const base: MetadataStoreData =
    read.status === "ok" ? structuredClone(read.data) : { version: 1 };
  const workspaces: Record<string, WorkspaceMetadata> = { ...base.workspaces };
  const resolvedCwd = resolve(cwd);
  const isRegistered = Object.keys(workspaces).some((key) => resolve(key) === resolvedCwd);
  if (isRegistered) {
    return { ok: true, added: false };
  }
  workspaces[resolvedCwd] = { addedAtMs };
  const next: MetadataStoreData = { ...base, workspaces };
  if (next.version === undefined) {
    next.version = 1;
  }
  try {
    writeMetadataStore(path, next);
  } catch (error) {
    return { ok: false, message: `Failed to write ${basename(path)}: ${errorMessage(error)}` };
  }
  return { ok: true, added: true };
}

/** Registered workspace cwds (resolved absolute paths), in registration order. */
export function registeredWorkspaceCwds(data: MetadataStoreData | undefined): string[] {
  return Object.keys(data?.workspaces ?? {});
}
