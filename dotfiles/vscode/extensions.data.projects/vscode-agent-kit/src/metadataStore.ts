import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
 *     "<session-id>": { "active": true }
 *   }
 * }
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

/** Whole metadata store document. Unknown top-level keys are preserved. */
export interface MetadataStoreData {
  version?: number;
  sessions?: Record<string, SessionMetadata>;
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
    return { status: "error", message: `${basename(path)} is not valid JSON: ${errorMessage(error)}` };
  }
  if (!isRecord(parsed)) {
    return { status: "error", message: `${basename(path)} must contain a JSON object` };
  }
  if (parsed.sessions !== undefined && !isRecord(parsed.sessions)) {
    return { status: "error", message: `${basename(path)}: "sessions" must be a JSON object` };
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
 * Read-modify-write a single session's `active` flag.
 * - Missing file: create the store fresh (version 1).
 * - Unreadable/unparseable file or write failure: nothing is written,
 *   `{ ok: false }` is returned so the caller can surface the error.
 * - The entry itself, its other attributes, other sessions, and unknown
 *   top-level keys are all preserved.
 */
export function setSessionActive(path: string, sessionId: string, active: boolean): MetadataUpdateResult {
  const read = readMetadataStore(path);
  if (read.status === "error") {
    return { ok: false, message: read.message };
  }
  const base: MetadataStoreData =
    read.status === "ok" ? structuredClone(read.data) : { version: 1, sessions: {} };
  const sessions: Record<string, SessionMetadata> = { ...base.sessions };
  sessions[sessionId] = { ...sessions[sessionId], active };
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

/** Session IDs whose `active` attribute is truthy (missing/falsy = inactive). */
export function activeSessionIds(data: MetadataStoreData | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(data?.sessions ?? {})) {
    if (isRecord(entry) && entry.active) {
      ids.add(id);
    }
  }
  return ids;
}
