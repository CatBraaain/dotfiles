import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { errorMessage, isRecord } from "./guards";

/**
 * Session state store shared with the pi extension `session-state`
 * (dotfiles), which adds the current session to `active-sessions` on every
 * sent message, provides the `/archive` and `/unarchive` commands, and writes
 * the live execution phase (`state`) of its own session.
 *
 * File shape (UTF-8 JSON, pretty printed):
 * {
 *   "active-workspaces": {
 *     "/absolute/path": {
 *       "active-sessions": {
 *         "<session-id>": { "state": "running" }
 *       }
 *     }
 *   }
 * }
 *
 * - Both levels follow the same rule: a key present in the map is active (the
 *   default view shows it), a key absent from the map is inactive.
 * - `active-workspaces` keys are the registered workspaces the view shows,
 *   including sessionless ones. This extension creates a key on New
 *   Workspace and deletes it on Unregister; the pi extension creates a key
 *   whenever Pi runs in a new cwd, so such cwds register themselves.
 * - `active-sessions` is keyed by session id; entries with a non-object value
 *   do not count as members.
 * - An entry's `state` is the live execution phase written by the pi extension.
 * - The pre-map formats are invalid and never rewritten: a workspace entry's
 *   `active-sessions` being an array, or a root `workspaces` object.
 * - Session entries lose their `lock` fields on rewrite. Other fields,
 *   workspace fields, and root keys are preserved.
 * - Concurrent writers (pi processes and this extension) follow
 *   last-write-wins semantics: each write is a full-file atomic replace
 *   (temp file + rename), with no locking.
 */

/** File name of the session state store inside Pi's agent directory. */
const SESSION_STATE_FILE_NAME = "session-state.json";

/** Live execution phase of a session, written by the pi extension as the
 * session entry's `state`. */
export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

/** Per-session entry in a workspace's `active-sessions` map. */
export interface ActiveSessionEntry {
  /** Live execution phase; missing means no phase information. */
  state?: SessionPhase;
  [key: string]: unknown;
}

/** Per-workspace state entry. Unknown fields are preserved. */
export interface WorkspaceStateEntry {
  /** Session ids mapped to their entries; ids missing from the map are archived. */
  "active-sessions"?: Record<string, ActiveSessionEntry>;
  [key: string]: unknown;
}

/** Whole session state document. Unknown top-level keys are preserved. */
export interface SessionStateStoreData {
  /** Registered workspaces keyed by cwd. */
  "active-workspaces": Record<string, WorkspaceStateEntry>;
  [key: string]: unknown;
}

export type SessionStateReadResult =
  /** File read and parsed successfully. */
  | { status: "ok"; data: SessionStateStoreData }
  /** File does not exist: behave as if there is no state. */
  | { status: "empty" }
  /** Unreadable or unparseable: behave as no state, never write, surface the message. */
  | { status: "error"; message: string };

export type SessionStateUpdateResult =
  | { ok: true; data: SessionStateStoreData }
  | { ok: false; message: string };

/** Parse a session state document with the same rules as the pi extension:
 * the root and `active-workspaces` must be objects, and neither the pre-map
 * `active-sessions` array nor the pre-rename root `workspaces` object may
 * appear. */
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

/** Read the session state store. Missing file => empty; otherwise strict parse. */
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

/**
 * Atomically replace the session state store file: write a temp file in the
 * same directory, then rename over the target. An interrupted write never
 * leaves the previous content half-written (rename is atomic on the same
 * filesystem). Throws on filesystem errors.
 */
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
      // Best-effort cleanup of the temp file; the original file is untouched.
    }
    throw error;
  }
}

function freshSessionStateStore(): SessionStateStoreData {
  return { "active-workspaces": {} };
}

/**
 * Read-modify-write the session state store. `update` mutates the parsed
 * store and returns whether anything changed; when it returns false no write
 * happens. Missing file: create the store fresh. Unreadable or unparseable
 * file and write failures write nothing and return `{ ok: false }` so the
 * caller can surface the error. Updates run on a structured clone.
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

/** Registered workspace cwds: the keys of the `active-workspaces` map. The
 * view shows one group per key; entries with an empty `active-sessions` map
 * are registered sessionless workspaces. */
export function registeredWorkspaceCwds(data: SessionStateStoreData | undefined): string[] {
  return Object.keys(data?.["active-workspaces"] ?? {});
}

export type RegisterWorkspaceResult = { ok: true; added: boolean } | { ok: false; message: string };

/** Register a workspace: create its entry with an empty `active-sessions`
 * map when the cwd has no entry yet. The pi extension creates entries the
 * same way, so a cwd where Pi runs registers itself. An already registered
 * cwd adds nothing. */
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

/** Unregister a workspace: delete its entry together with its session
 * memberships. A Pi still running in the cwd recreates the entry on its next
 * sent message. */
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

/** The store key naming the same directory as `cwd`, if any. */
function workspaceKeyOf(store: SessionStateStoreData, cwd: string): string | undefined {
  const resolved = resolve(cwd);
  return Object.keys(store["active-workspaces"]).find((key) => resolve(key) === resolved);
}

/** Session ids listed in any workspace's `active-sessions` map. */
export function activeSessionIds(data: SessionStateStoreData | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of sessionEntries(data)) {
    ids.add(entry.sessionId);
  }
  return ids;
}

/** Live execution phases keyed by session id; entries without a valid
 * `state` are omitted. */
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

/** Every session entry listed in any workspace's `active-sessions` map. */
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

/** One membership target: the session and its workspace cwd. */
export interface SessionRef {
  sessionId: string;
  cwd: string;
}

/** The session's entry in its workspace's `active-sessions` map, or undefined
 * when the session is not a member (archived) or the value is not an object. */
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

/** The workspace entry the update functions mutate, created when missing. */
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

/** The workspace entry's `active-sessions` map, created when missing or not
 * an object (the pre-map array is rejected at parse time). */
function activeSessionsMapOf(entry: WorkspaceStateEntry): Record<string, ActiveSessionEntry> {
  const activeSessions = entry["active-sessions"];
  if (isRecord(activeSessions)) return activeSessions as Record<string, ActiveSessionEntry>;
  const fresh: Record<string, ActiveSessionEntry> = {};
  entry["active-sessions"] = fresh;
  return fresh;
}

/**
 * Archive the given sessions in one store write: delete each entry from its
 * workspace's `active-sessions` map. Sessions that are not members are left alone.
 */
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

/**
 * Unarchive the given sessions in one store write: create each missing entry
 * as `{}`. Existing entries keep their `state` and unknown fields.
 */
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

/** Add one session to its workspace's `active-sessions` map when missing. */
export function addActiveSession(
  path: string,
  workspaceCwd: string,
  sessionId: string,
): SessionStateUpdateResult {
  return unarchiveSessions(path, [{ sessionId, cwd: workspaceCwd }]);
}
