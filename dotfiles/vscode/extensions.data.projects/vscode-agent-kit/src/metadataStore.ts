import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { errorMessage, isRecord } from "./guards";
import type { SessionSummary } from "./sessionStore";

/**
 * Session state store shared with the pi extension `session-state`
 * (dotfiles), which adds the current session to `active-sessions` on every
 * sent message and provides the `/archive` and `/unarchive` commands.
 *
 * File shape (UTF-8 JSON, pretty printed):
 * {
 *   "version": 2,
 *   "workspaces": {
 *     "/absolute/path": {
 *       "active": true,
 *       "active-sessions": ["<session-id>"],
 *       "locked-sessions": ["<session-id>"],
 *       "archived-names": { "<session-id>": "archived display name" }
 *     }
 *   },
 *   "registered-workspaces": ["/absolute/path"],
 *   "migrated-v1": true
 * }
 *
 * - `active-sessions` is the whitelist the default view shows; ids missing
 *   from it are inactive (archived) and only visible in the All view.
 * - `locked-sessions` protects a session from being archived (membership
 *   removal) until it is unlocked. Locking never blocks unarchiving.
 * - `archived-names` snapshots inactive sessions' display names so scans can
 *   skip reading their file bodies.
 * - A workspace entry's `active: false` hides the whole group from the
 *   default view; the All view still shows it.
 * - `registered-workspaces` lists the cwds whose groups the view shows. The
 *   pi extension creates workspace entries for any cwd it touches, and only
 *   registered cwds become groups.
 * - The store version must be exactly 2: the pi extension refuses other
 *   versions, so this extension writes version 2 only.
 * - Unknown root keys and unknown workspace fields are preserved on rewrite.
 * - Concurrent writers (pi processes and this extension) follow
 *   last-write-wins semantics: each write is a full-file atomic replace
 *   (temp file + rename), with no locking.
 */

/** Root key marking that the v1 metadata store has already been migrated. */
const MIGRATED_V1_KEY = "migrated-v1";

/** Root key listing the workspace cwds whose groups the view shows. */
const REGISTERED_WORKSPACES_KEY = "registered-workspaces";

/** Per-workspace state entry. Unknown fields are preserved. */
export interface WorkspaceStateEntry {
  /** Workspace-level view toggle; missing or true shows the group by default. */
  active?: boolean;
  "active-sessions"?: string[];
  "locked-sessions"?: string[];
  "archived-names"?: Record<string, string>;
  [key: string]: unknown;
}

/** Whole session state document. Unknown top-level keys are preserved. */
export interface SessionStateStoreData {
  version: number;
  workspaces: Record<string, WorkspaceStateEntry>;
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

/** Parse a session state document with the same rules as the pi extension. */
export function parseSessionStateStore(raw: string): SessionStateReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "error",
      message: `${basename(SESSION_STATE_FILE_NAME)} is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.workspaces)) {
    return {
      status: "error",
      message: `${basename(SESSION_STATE_FILE_NAME)} is not a valid session-state store`,
    };
  }
  return { status: "ok", data: parsed as SessionStateStoreData };
}

const SESSION_STATE_FILE_NAME = "session-state.json";

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
  return { version: 2, workspaces: {} };
}

/**
 * Read-modify-write the session state store. `update` mutates the parsed
 * store and returns whether anything changed; when it returns false no write
 * happens. Missing file: create the store fresh (version 2). Unreadable or
 * unparseable file and write failures write nothing and return
 * `{ ok: false }` so the caller can surface the error. Unknown keys and
 * fields are preserved (updates run on a structured clone).
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
  try {
    writeSessionStateStore(path, base);
  } catch (error) {
    return { ok: false, message: `Failed to write ${basename(path)}: ${errorMessage(error)}` };
  }
  return { ok: true, data: base };
}

/** Registered workspace cwds (resolved absolute paths), in registration order. */
export function registeredWorkspaceCwds(data: SessionStateStoreData | undefined): string[] {
  const registered = data?.[REGISTERED_WORKSPACES_KEY];
  return Array.isArray(registered) ? registered.filter((cwd) => typeof cwd === "string") : [];
}

/** Workspace cwds whose entry toggles the group off in the default view. */
export function hiddenWorkspaceCwds(data: SessionStateStoreData | undefined): Set<string> {
  const hidden = new Set<string>();
  for (const [cwd, entry] of Object.entries(data?.workspaces ?? {})) {
    if (isRecord(entry) && entry.active === false) {
      hidden.add(cwd);
    }
  }
  return hidden;
}

/** Session IDs listed in any workspace's `active-sessions`. */
export function activeSessionIds(data: SessionStateStoreData | undefined): Set<string> {
  return sessionIdsIn(data, "active-sessions");
}

/** Session IDs listed in any workspace's `locked-sessions`. */
export function lockedSessionIds(data: SessionStateStoreData | undefined): Set<string> {
  return sessionIdsIn(data, "locked-sessions");
}

/** Inactive sessions' display-name snapshots, keyed by session id. */
export function archivedSessionNames(data: SessionStateStoreData | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of Object.values(data?.workspaces ?? {})) {
    if (!isRecord(entry) || !isRecord(entry["archived-names"])) continue;
    for (const [id, name] of Object.entries(entry["archived-names"])) {
      if (typeof name === "string") names.set(id, name);
    }
  }
  return names;
}

type SessionListField = "active-sessions" | "locked-sessions";

function sessionIdsIn(
  data: SessionStateStoreData | undefined,
  field: SessionListField,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(data?.workspaces ?? {})) {
    if (!isRecord(entry)) continue;
    const listed = entry[field];
    if (Array.isArray(listed)) {
      for (const id of listed) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return ids;
}

/** Workspace entry the update functions mutate, created when missing. */
function entryOf(
  workspaces: Record<string, WorkspaceStateEntry>,
  workspaceCwd: string,
): WorkspaceStateEntry {
  const entry = workspaces[workspaceCwd];
  if (isRecord(entry)) return entry as WorkspaceStateEntry;
  const fresh: WorkspaceStateEntry = {};
  workspaces[workspaceCwd] = fresh;
  return fresh;
}

function sessionList(entry: WorkspaceStateEntry, field: SessionListField): string[] {
  const listed = entry[field];
  return Array.isArray(listed) ? listed.filter((id) => typeof id === "string") : [];
}

function archivedNamesOf(entry: WorkspaceStateEntry): Record<string, string> {
  const names = entry["archived-names"];
  if (!isRecord(names)) {
    const fresh: Record<string, string> = {};
    entry["archived-names"] = fresh;
    return fresh;
  }
  return names as Record<string, string>;
}

/** One archive target: the session, its workspace cwd, and the display name to snapshot. */
export interface ArchiveEntry {
  sessionId: string;
  cwd: string;
  displayName: string;
}

/** One membership target: the session and its workspace cwd. */
export interface SessionRef {
  sessionId: string;
  cwd: string;
}

/** One lock target: the session, its workspace cwd, and the next lock state. */
export interface LockEntry {
  sessionId: string;
  cwd: string;
  locked: boolean;
}

/** True when any workspace entry lists the session in `field`. */
function isSessionListed(
  workspaces: Record<string, WorkspaceStateEntry>,
  sessionId: string,
  field: SessionListField,
): boolean {
  return Object.values(workspaces).some(
    (entry) =>
      isRecord(entry) && sessionList(entry as WorkspaceStateEntry, field).includes(sessionId),
  );
}

/**
 * Archive the given sessions in one store write: remove each from its
 * workspace's `active-sessions` and snapshot its display name in
 * `archived-names`. Locked sessions are skipped, so a stale UI or a direct
 * message cannot archive them.
 */
export function archiveSessions(
  path: string,
  entries: readonly ArchiveEntry[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    let archivedAny = false;
    for (const entry of entries) {
      if (isSessionListed(store.workspaces, entry.sessionId, "locked-sessions")) continue;
      const workspaceEntry = entryOf(store.workspaces, entry.cwd);
      const active = sessionList(workspaceEntry, "active-sessions");
      if (active.includes(entry.sessionId)) {
        workspaceEntry["active-sessions"] = active.filter((id) => id !== entry.sessionId);
      }
      archivedNamesOf(workspaceEntry)[entry.sessionId] = entry.displayName;
      archivedAny = true;
    }
    return archivedAny;
  });
}

/**
 * Unarchive the given sessions in one store write: add each to its
 * workspace's `active-sessions` and drop its display-name snapshot so the
 * next scan re-reads it from the session file. Locking protects only against
 * archiving, so locked sessions unarchive as well.
 */
export function unarchiveSessions(
  path: string,
  entries: readonly SessionRef[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    let changedAny = false;
    for (const ref of entries) {
      const workspaceEntry = entryOf(store.workspaces, ref.cwd);
      const active = sessionList(workspaceEntry, "active-sessions");
      if (!active.includes(ref.sessionId)) {
        workspaceEntry["active-sessions"] = [...active, ref.sessionId];
        changedAny = true;
      }
      const names = workspaceEntry["archived-names"];
      if (isRecord(names) && typeof names[ref.sessionId] === "string") {
        delete names[ref.sessionId];
        if (Object.keys(names).length === 0) delete workspaceEntry["archived-names"];
        changedAny = true;
      }
    }
    return changedAny;
  });
}

/** Add one session to its workspace's `active-sessions` (pi-extension parity). */
export function addActiveSession(
  path: string,
  workspaceCwd: string,
  sessionId: string,
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    const workspaceEntry = entryOf(store.workspaces, workspaceCwd);
    const active = sessionList(workspaceEntry, "active-sessions");
    if (active.includes(sessionId)) return false;
    workspaceEntry["active-sessions"] = [...active, sessionId];
    return true;
  });
}

/** Add or remove the sessions' lock (archive protection) in one store write. */
export function setSessionLocks(
  path: string,
  entries: readonly LockEntry[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    let changedAny = false;
    for (const entry of entries) {
      const workspaceEntry = entryOf(store.workspaces, entry.cwd);
      const locked = sessionList(workspaceEntry, "locked-sessions");
      const isListed = locked.includes(entry.sessionId);
      if (entry.locked && !isListed) {
        workspaceEntry["locked-sessions"] = [...locked, entry.sessionId];
        changedAny = true;
      } else if (!entry.locked && isListed) {
        workspaceEntry["locked-sessions"] = locked.filter((id) => id !== entry.sessionId);
        changedAny = true;
      }
    }
    return changedAny;
  });
}

export type RegisterWorkspaceResult = { ok: true; added: boolean } | { ok: false; message: string };

/**
 * Register a workspace cwd: append the resolved absolute path to the
 * `registered-workspaces` list. The workspace entry (membership lists,
 * snapshots, toggle) is left untouched, so unregistering and registering
 * again restores the previous groups. An already registered cwd adds nothing.
 */
export function registerWorkspace(path: string, cwd: string): RegisterWorkspaceResult {
  let added = false;
  const result = mutateSessionStateStore(path, (store) => {
    const resolvedCwd = resolve(cwd);
    const registered = Array.isArray(store[REGISTERED_WORKSPACES_KEY])
      ? (store[REGISTERED_WORKSPACES_KEY] as unknown[]).filter((value) => typeof value === "string")
      : [];
    if (registered.some((key) => resolve(key) === resolvedCwd)) return false;
    store[REGISTERED_WORKSPACES_KEY] = [...registered, resolvedCwd];
    added = true;
    return true;
  });
  return result.ok ? { ok: true, added } : result;
}

export type UnregisterWorkspaceResult =
  | { ok: true; removed: boolean }
  | { ok: false; message: string };

/**
 * Remove a workspace cwd from the registered list. The workspace entry and
 * its membership lists stay on disk, so sessions keep their state while the
 * group is hidden. No write happens when the cwd is not registered.
 */
export function unregisterWorkspace(path: string, cwd: string): UnregisterWorkspaceResult {
  let removed = false;
  const result = mutateSessionStateStore(path, (store) => {
    const registered = Array.isArray(store[REGISTERED_WORKSPACES_KEY])
      ? (store[REGISTERED_WORKSPACES_KEY] as unknown[]).filter((value) => typeof value === "string")
      : [];
    const resolvedCwd = resolve(cwd);
    const nextRegistered = registered.filter((key) => resolve(key) !== resolvedCwd);
    if (nextRegistered.length === registered.length) return false;
    store[REGISTERED_WORKSPACES_KEY] = nextRegistered;
    removed = true;
    return true;
  });
  return result.ok ? { ok: true, removed } : result;
}

/**
 * Build the migrated v2 store from the v1 metadata store and the scanned
 * sessions of the v1 registered workspaces. Pure: returns the store to write,
 * the caller writes it. Merging rules against an existing v2 store (the pi
 * extension may have created one already):
 * - registered cwds: v1 keys union existing list;
 * - active-sessions: v1 visible sessions union existing lists;
 * - locked-sessions: v1 locked sessions union existing lists;
 * - archived-names: v1 snapshots union existing snapshots (v1 wins on
 *   conflict, so the archived display name stays stable).
 */
export function buildV1Migration(
  legacy: LegacyMetadataStoreData,
  existing: SessionStateStoreData | undefined,
  summaries: readonly SessionSummary[],
): SessionStateStoreData {
  const next: SessionStateStoreData = existing
    ? structuredClone(existing)
    : freshSessionStateStore();
  next.version = 2;
  const registered = new Set(registeredWorkspaceCwds(next));
  for (const cwd of Object.keys(legacy.workspaces ?? {})) {
    registered.add(cwd);
    entryOf(next.workspaces, cwd);
  }
  const registeredKeys = new Set(Object.keys(legacy.workspaces ?? {}).map((cwd) => resolve(cwd)));
  const legacySessions = legacy.sessions ?? {};
  for (const summary of summaries) {
    if (!registeredKeys.has(resolve(summary.cwd))) continue;
    const entry = isRecord(legacySessions[summary.sessionId])
      ? (legacySessions[summary.sessionId] as Record<string, unknown>)
      : undefined;
    const workspaceEntry = entryOf(next.workspaces, summary.cwd);
    if (entry?.locked === true) {
      const locked = sessionList(workspaceEntry, "locked-sessions");
      if (!locked.includes(summary.sessionId)) {
        workspaceEntry["locked-sessions"] = [...locked, summary.sessionId];
      }
    }
    // v1 archived sessions (active explicitly false) leave the active list;
    // their display-name snapshot falls back to the scanned display name.
    if (entry?.active === false) {
      const snapshot = typeof entry.name === "string" ? entry.name : summary.displayName;
      archivedNamesOf(workspaceEntry)[summary.sessionId] = snapshot;
      continue;
    }
    const active = sessionList(workspaceEntry, "active-sessions");
    if (!active.includes(summary.sessionId)) {
      workspaceEntry["active-sessions"] = [...active, summary.sessionId];
    }
  }
  next[REGISTERED_WORKSPACES_KEY] = [...registered];
  next[MIGRATED_V1_KEY] = true;
  return next;
}

/**
 * Read-modify-write the migrated v2 store: merge the v1 metadata store's
 * registrations, active, locked, and archived-name state into the session
 * state store, then set the migration marker. Returns without writing when
 * the marker is already set.
 */
export function migrateLegacyStore(
  path: string,
  legacy: LegacyMetadataStoreData,
  summaries: readonly SessionSummary[],
): SessionStateUpdateResult {
  return mutateSessionStateStore(path, (store) => {
    if (store[MIGRATED_V1_KEY] === true) return false;
    const migrated = buildV1Migration(legacy, store, summaries);
    for (const [key, value] of Object.entries(migrated)) {
      (store as Record<string, unknown>)[key] = value;
    }
    return true;
  });
}

/** The v1 metadata store this extension wrote before the session state store. */
export interface LegacyMetadataStoreData {
  version?: number;
  sessions?: Record<string, Record<string, unknown>>;
  workspaces?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export type LegacyMetadataReadResult =
  | { status: "ok"; data: LegacyMetadataStoreData }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Read the v1 metadata store for the one-time migration. Lenient parse: the
 * file is only read, never written, and unknown shapes degrade to defaults. */
export function readLegacyMetadataStore(path: string): LegacyMetadataReadResult {
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
  return { status: "ok", data: parsed as LegacyMetadataStoreData };
}

/** Registered workspace cwds of the v1 metadata store. */
export function legacyRegisteredWorkspaceCwds(data: LegacyMetadataStoreData): string[] {
  return Object.keys(data.workspaces ?? {});
}

/** Archived display-name snapshots of the v1 metadata store, keyed by session id. */
export function legacyArchivedSessionNames(data: LegacyMetadataStoreData): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, entry] of Object.entries(data.sessions ?? {})) {
    if (isRecord(entry) && entry.active === false && typeof entry.name === "string") {
      names.set(id, entry.name);
    }
  }
  return names;
}
