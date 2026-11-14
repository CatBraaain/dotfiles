import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { errorMessage, isRecord } from "./guards";

/**
 * Session state store. Only this extension writes the store; the pi
 * extension `session-state` does not. The pi extension reports the live
 * execution phase through `pi-mux` (tmux pane options), so this extension
 * reads live phases from `pi-mux list`, not from this file.
 *
 * File shape (UTF-8 JSON, pretty printed):
 * {
 *   "active-workspaces": {
 *     "/absolute/path": {
 *       "active-sessions": {
 *         "<session-id>": {}
 *       }
 *     }
 *   }
 * }
 *
 * - Both levels follow the same rule: a key present in the map is active (the
 *   default view shows it), a key absent from the map is inactive.
 * - `active-workspaces` keys are the registered workspaces the view shows,
 *   including sessionless ones. This extension creates a key on New
 *   Workspace and deletes it on Unregister.
 * - `active-sessions` is keyed by session id; entries with a non-object value
 *   do not count as members.
 * - Session entries are created as empty objects; no current writer fills
 *   their `state`. Existing `state` values are preserved on rewrite, but the
 *   live view does not read them.
 * - The pre-map formats are invalid and never rewritten: a workspace entry's
 *   `active-sessions` being an array, or a root `workspaces` object.
 * - Session entries lose their `lock` fields on rewrite. Other fields,
 *   workspace fields, and root keys are preserved.
 * - Writes follow last-write-wins semantics: each write is a full-file
 *   atomic replace (temp file + rename), with no locking.
 */

const SESSION_STATE_FILE_NAME = "session-state.json";

export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

export interface ActiveSessionEntry {
  state?: SessionPhase;
  [key: string]: unknown;
}

export interface WorkspaceStateEntry {
  "active-sessions"?: Record<string, ActiveSessionEntry>;
  [key: string]: unknown;
}

export interface SessionStateStoreData {
  "active-workspaces": Record<string, WorkspaceStateEntry>;
  [key: string]: unknown;
}

export type SessionStateReadResult =
  | { status: "ok"; data: SessionStateStoreData }
  | { status: "empty" }
  | { status: "error"; message: string };

export type SessionStateUpdateResult =
  | { ok: true; data: SessionStateStoreData }
  | { ok: false; message: string };

/** Strict parse: the root and `active-workspaces` must be objects, and
 * neither the pre-map `active-sessions` array nor the pre-rename root
 * `workspaces` object may appear. */
export function parseSessionStateStore(raw: string): SessionStateReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "error",
      message: `${SESSION_STATE_FILE_NAME} is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed["active-workspaces"]) ||
    isRecord(parsed.workspaces) ||
    hasLegacyActiveSessionsList(parsed["active-workspaces"])
  ) {
    return {
      status: "error",
      message: `${SESSION_STATE_FILE_NAME} is not a valid session-state store`,
    };
  }
  return { status: "ok", data: parsed as SessionStateStoreData };
}

function hasLegacyActiveSessionsList(activeWorkspaces: Record<string, unknown>): boolean {
  return Object.values(activeWorkspaces).some(
    (entry) => isRecord(entry) && Array.isArray(entry["active-sessions"]),
  );
}

/** Missing file => empty; otherwise strict parse. */
export function readSessionStateStore(path: string): SessionStateReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "empty" };
    return {
      status: "error",
      message: `${SESSION_STATE_FILE_NAME}: ${errorMessage(error)}`,
    };
  }
  return parseSessionStateStore(raw);
}

export function writeSessionStateStore(path: string, data: SessionStateStoreData): void {
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
      // Best-effort cleanup; the write error is rethrown below.
    }
    throw error;
  }
}

function freshSessionStateStore(): SessionStateStoreData {
  return { "active-workspaces": {} };
}

/**
 * `update` mutates the parsed store on a structured clone and returns
 * whether anything changed; when it returns false no write happens.
 * Missing file: create the store fresh. Unreadable or unparseable file and
 * write failures write nothing and return `{ ok: false }` so the caller
 * can surface the error.
 */
export function mutateSessionStateStore(
  path: string,
  update: (store: SessionStateStoreData) => boolean,
): SessionStateUpdateResult {
  const read = readSessionStateStore(path);
  if (read.status === "error") {
    return { ok: false, message: read.message };
  }
  const base: SessionStateStoreData =
    read.status === "ok" ? structuredClone(read.data) : freshSessionStateStore();
  if (!update(base)) {
    return { ok: true, data: read.status === "ok" ? read.data : base };
  }
  for (const { sessionEntry } of sessionEntries(base)) delete sessionEntry.lock;
  try {
    writeSessionStateStore(path, base);
  } catch (error) {
    return { ok: false, message: `Failed to write ${basename(path)}: ${errorMessage(error)}` };
  }
  return { ok: true, data: base };
}

export function registeredWorkspaceCwds(data: SessionStateStoreData | undefined): string[] {
  return Object.keys(data?.["active-workspaces"] ?? {});
}

export type RegisterWorkspaceResult = { ok: true; added: boolean } | { ok: false; message: string };

export function registerWorkspace(path: string, cwd: string): RegisterWorkspaceResult {
  let added = false;
  const result = mutateSessionStateStore(path, (store) => {
    if (workspaceKeyOf(store, cwd) !== undefined) return false;
    store["active-workspaces"][resolve(cwd)] = { "active-sessions": {} };
    added = true;
    return true;
  });
  return result.ok ? { ok: true, added } : result;
}

export type UnregisterWorkspaceResult =
  | { ok: true; removed: boolean }
  | { ok: false; message: string };

export function unregisterWorkspace(path: string, cwd: string): UnregisterWorkspaceResult {
  let removed = false;
  const result = mutateSessionStateStore(path, (store) => {
    const key = workspaceKeyOf(store, cwd);
    if (key === undefined) return false;
    delete store["active-workspaces"][key];
    removed = true;
    return true;
  });
  return result.ok ? { ok: true, removed } : result;
}

function workspaceKeyOf(store: SessionStateStoreData, cwd: string): string | undefined {
  const resolved = resolve(cwd);
  return Object.keys(store["active-workspaces"]).find((key) => resolve(key) === resolved);
}

export function activeSessionIds(data: SessionStateStoreData | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of sessionEntries(data)) {
    ids.add(entry.sessionId);
  }
  return ids;
}

export function sessionPhases(data: SessionStateStoreData | undefined): Map<string, SessionPhase> {
  const phases = new Map<string, SessionPhase>();
  for (const { sessionId, sessionEntry } of sessionEntries(data)) {
    if (isSessionPhase(sessionEntry.state)) phases.set(sessionId, sessionEntry.state);
  }
  return phases;
}

function isSessionPhase(value: unknown): value is SessionPhase {
  return value === "running" || value === "waiting-approval" || value === "waiting-user";
}

interface ListedSession {
  sessionId: string;
  sessionEntry: ActiveSessionEntry;
}

function* sessionEntries(data: SessionStateStoreData | undefined): Generator<ListedSession> {
  for (const workspaceEntry of Object.values(data?.["active-workspaces"] ?? {})) {
    if (!isRecord(workspaceEntry)) continue;
    const activeSessions = workspaceEntry["active-sessions"];
    if (!isRecord(activeSessions)) continue;
    for (const [sessionId, listed] of Object.entries(activeSessions)) {
      if (isRecord(listed)) yield { sessionId, sessionEntry: listed as ActiveSessionEntry };
    }
  }
}

export interface SessionRef {
  sessionId: string;
  cwd: string;
}

function listedSessionEntry(
  store: SessionStateStoreData,
  cwd: string,
  sessionId: string,
): ActiveSessionEntry | undefined {
  const workspaceEntry = store["active-workspaces"][cwd];
  if (!isRecord(workspaceEntry)) return undefined;
  const activeSessions = workspaceEntry["active-sessions"];
  if (!isRecord(activeSessions)) return undefined;
  const listed = activeSessions[sessionId];
  return isRecord(listed) ? (listed as ActiveSessionEntry) : undefined;
}

function workspaceEntryOf(
  activeWorkspaces: Record<string, WorkspaceStateEntry>,
  cwd: string,
): WorkspaceStateEntry {
  const entry = activeWorkspaces[cwd];
  if (isRecord(entry)) return entry as WorkspaceStateEntry;
  const fresh: WorkspaceStateEntry = {};
  activeWorkspaces[cwd] = fresh;
  return fresh;
}

function activeSessionsMapOf(entry: WorkspaceStateEntry): Record<string, ActiveSessionEntry> {
  const activeSessions = entry["active-sessions"];
  if (isRecord(activeSessions)) return activeSessions as Record<string, ActiveSessionEntry>;
  const fresh: Record<string, ActiveSessionEntry> = {};
  entry["active-sessions"] = fresh;
  return fresh;
}

export function archiveSessions(
  path: string,
  refs: readonly SessionRef[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    let changedAny = false;
    for (const ref of refs) {
      const listed = listedSessionEntry(store, ref.cwd, ref.sessionId);
      if (listed === undefined) continue;
      const workspaceEntry = workspaceEntryOf(store["active-workspaces"], ref.cwd);
      delete activeSessionsMapOf(workspaceEntry)[ref.sessionId];
      changedAny = true;
    }
    return changedAny;
  });
}

export function unarchiveSessions(
  path: string,
  refs: readonly SessionRef[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    let changedAny = false;
    for (const ref of refs) {
      if (listedSessionEntry(store, ref.cwd, ref.sessionId) !== undefined) continue;
      const workspaceEntry = workspaceEntryOf(store["active-workspaces"], ref.cwd);
      activeSessionsMapOf(workspaceEntry)[ref.sessionId] = {};
      changedAny = true;
    }
    return changedAny;
  });
}

export function addActiveSession(
  path: string,
  workspaceCwd: string,
  sessionId: string,
): SessionStateUpdateResult {
  return unarchiveSessions(path, [{ sessionId, cwd: workspaceCwd }]);
}
