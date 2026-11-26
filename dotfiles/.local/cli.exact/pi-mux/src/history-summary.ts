import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "./platform";

const SUMMARY_READ_CHUNK_BYTES = 256 * 1024;
const SUMMARY_CACHE_VERSION = 6;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_HEADER_PREFIX_BYTES = 1024;
const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const FIRST_MESSAGE_MAX_CODE_POINTS = 80;
const JSON_UNICODE_ESCAPE_BYTES = Buffer.from("\\u");
const SESSION_INFO_TYPE_BYTES = Buffer.from('"session_info"');
const USER_ROLE_BYTES = Buffer.from('"user"');
const UNDERSCORE_BYTE = "_".charCodeAt(0);
const LOWERCASE_U_BYTE = "u".charCodeAt(0);
const SUMMARY_MARKER_OVERLAP_BYTES =
  Math.max(
    SESSION_INFO_TYPE_BYTES.length,
    USER_ROLE_BYTES.length,
    JSON_UNICODE_ESCAPE_BYTES.length,
  ) - 1;
const LAST_RUN_SCAN_BYTES = 16 * 1024 * 1024;
const LAST_RUN_CUSTOM_TYPE = "pi-mux-last-run";
const LAST_RUN_CUSTOM_TYPE_BYTES = Buffer.from(`"${LAST_RUN_CUSTOM_TYPE}"`);
const CUSTOM_TYPE_BYTES = Buffer.from('"custom"');

export type SavedSessionSummary = { title: string | null; mtime: number | null };
export type LastRun = { atMs: number; aborted: boolean };

type SavedSessionHeader = { id: string; cwd: string; btime: number };
type StoredSummary = SavedSessionSummary & {
  btime: number | null;
  header: SavedSessionHeader | null;
  fingerprint?: string;
};
type SavedSessionHistory = StoredSummary & { size: number };
type CachedSummary = StoredSummary & { fingerprint: string; header: SavedSessionHeader };
type SummaryGroup = {
  path: string;
  entries: Record<string, unknown>;
  updates: Map<string, CachedSummary>;
  discoveredFiles?: ReadonlySet<string>;
};
type SummaryScan = { mtime: number | null; mayHaveUserMessage: boolean };

export function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export class HistorySummaryCache {
  private directory: string | null | undefined;
  private readonly groups = new Map<string, SummaryGroup>();

  resolve(file: string): SavedSessionSummary {
    const summary = this.resolveHistory(file);
    return { title: summary?.title ?? null, mtime: summary?.mtime ?? null };
  }

  resolveHistory(
    file: string,
    acceptHeader?: (header: SavedSessionHeader) => boolean,
  ): SavedSessionHistory | undefined {
    return this.resolveFile(file, acceptHeader, true);
  }

  resolveDirectHistory(
    file: string,
    acceptHeader: (header: SavedSessionHeader) => boolean,
    verifyParent: () => boolean,
  ): SavedSessionHistory | undefined {
    return this.resolveFile(file, acceptHeader, true, verifyParent);
  }

  recordDiscoveredFiles(sourceDirectory: string, files: string[]): void {
    const group = this.loadGroup(resolve(sourceDirectory));
    if (group) group.discoveredFiles = new Set(files);
  }

  flush(): void {
    const dirtyGroups = [...this.groups].filter(
      ([sourceDirectory, group]) =>
        group.updates.size > 0 ||
        (group.discoveredFiles &&
          Object.keys(group.entries).some((file) =>
            isMissingOriginal(sourceDirectory, group.discoveredFiles, file),
          )),
    );
    if (dirtyGroups.length === 0 || !this.directory || !isPrivateCacheDirectory(this.directory))
      return;
    for (const [sourceDirectory, group] of dirtyGroups) {
      const latest = loadSummaryGroup(group.path, sourceDirectory);
      const entries = entriesToSave(sourceDirectory, group, latest);
      const saved =
        Object.keys(entries).length > 0
          ? saveSummaryGroup(group.path, sourceDirectory, entries)
          : !latest || removeEmptySummaryGroup(group.path);
      if (!saved) continue;
      group.entries = entries;
      group.updates.clear();
    }
  }

  private loadGroup(sourceDirectory: string): SummaryGroup | undefined {
    const loaded = this.groups.get(sourceDirectory);
    if (loaded) return loaded;
    if (this.directory === undefined) this.directory = prepareSummaryCacheDirectory();
    if (!this.directory) return undefined;
    const key = createHash("sha256").update(sourceDirectory).digest("hex");
    const path = join(this.directory, `group-${key}.json`);
    const group = {
      path,
      entries: loadSummaryGroup(path, sourceDirectory) ?? {},
      updates: new Map<string, CachedSummary>(),
    };
    this.groups.set(sourceDirectory, group);
    return group;
  }

  private resolveFile(
    file: string,
    acceptHeader: ((header: SavedSessionHeader) => boolean) | undefined,
    allowsRetry: boolean,
    verifyParent?: () => boolean,
  ): SavedSessionHistory | undefined {
    let fd: number | undefined;
    try {
      const originalName = verifyParent ? lstatSync(file, { bigint: true }) : undefined;
      if (originalName && !originalName.isFile()) return undefined;
      const noFollow = verifyParent ? constants.O_NOFOLLOW : 0;
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) return undefined;
      if (verifyParent) {
        const currentName = directHistoryName(file, verifyParent);
        if (
          !originalName ||
          before.ino === 0n ||
          !sameIdentity(before, originalName) ||
          !currentName ||
          !sameIdentity(before, currentName)
        )
          return undefined;
      }
      const fingerprint = fileFingerprint(before);
      const group = this.loadGroup(dirname(file));
      const cached = group ? getCachedSummary(group, file, fingerprint) : undefined;
      const header = cached ? cached.header : readSavedSessionHeader(fd);
      if (acceptHeader && (!header || !acceptHeader(header))) return undefined;
      const resolved = cached ?? readSavedSessionSummary(fd, Number(before.size), header);
      let stable = sameFingerprint(before, fstatSync(fd, { bigint: true }));
      if (stable) {
        const currentName = verifyParent
          ? directHistoryName(file, verifyParent)
          : statSync(file, { bigint: true });
        stable = currentName !== undefined && sameFingerprint(before, currentName);
      }
      if (!stable) {
        if (allowsRetry) return this.resolveFile(file, acceptHeader, false, verifyParent);
        return verifyParent ? undefined : { ...resolved, size: Number(before.size) };
      }
      if (!cached && group && isValidCachedSummary(resolved, fingerprint))
        group.updates.set(file, resolved);
      return { ...resolved, size: Number(before.size) };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function directHistoryName(file: string, verifyParent: () => boolean): BigIntStats | undefined {
  const named = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return named?.isFile() && verifyParent() ? named : undefined;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function prepareSummaryCacheDirectory(): string | null {
  const configured = process.env.XDG_CACHE_HOME;
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
  const directory = join(root, "pi-mux", "history-titles");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return isPrivateCacheDirectory(directory) ? directory : null;
}

function isPrivateCacheDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && platform.ownedFileEntry(stat);
  } catch {
    return false;
  }
}

function loadSummaryGroup(
  path: string,
  sourceDirectory: string,
): Record<string, unknown> | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !platform.ownedFileEntry(stat)) return undefined;
      const group: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (
        !isJsonObject(group) ||
        group.version !== SUMMARY_CACHE_VERSION ||
        group.directory !== sourceDirectory ||
        !isJsonObject(group.entries)
      )
        return undefined;
      return group.entries;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function getCachedSummary(
  group: SummaryGroup,
  file: string,
  fingerprint: string,
): StoredSummary | undefined {
  const entry =
    group.updates.get(file) ??
    (Object.hasOwn(group.entries, file) ? group.entries[file] : undefined);
  if (!isValidCachedSummary(entry, fingerprint)) return undefined;
  return { title: entry.title, btime: entry.btime, mtime: entry.mtime, header: entry.header };
}

function isValidCachedSummary(entry: unknown, fingerprint?: string): entry is CachedSummary {
  return (
    isJsonObject(entry) &&
    (fingerprint === undefined
      ? typeof entry.fingerprint === "string"
      : entry.fingerprint === fingerprint) &&
    isValidTitle(entry.title) &&
    isValidTime(entry.btime) &&
    isValidTime(entry.mtime) &&
    isValidHeader(entry.header)
  );
}

function isMissingOriginal(
  sourceDirectory: string,
  discoveredFiles: ReadonlySet<string> | undefined,
  file: string,
): boolean {
  if (!discoveredFiles || discoveredFiles.has(file) || dirname(file) !== sourceDirectory)
    return false;
  try {
    return lstatSync(file, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function entriesToSave(
  sourceDirectory: string,
  group: SummaryGroup,
  latest: Record<string, unknown> | undefined,
): Record<string, CachedSummary> {
  const merged = { ...latest, ...Object.fromEntries(group.updates) };
  const entries = new Map<string, CachedSummary>();
  for (const [file, entry] of Object.entries(merged)) {
    if (dirname(file) !== sourceDirectory || !isValidCachedSummary(entry)) continue;
    if (isMissingOriginal(sourceDirectory, group.discoveredFiles, file)) continue;
    const { fingerprint, title, btime, mtime, header } = entry;
    entries.set(file, {
      fingerprint,
      title,
      btime,
      mtime,
      header: { id: header.id, cwd: header.cwd, btime: header.btime },
    });
  }
  return Object.fromEntries(entries);
}

function removeEmptySummaryGroup(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function saveSummaryGroup(
  path: string,
  sourceDirectory: string,
  entries: Record<string, unknown>,
): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ version: SUMMARY_CACHE_VERSION, directory: sourceDirectory, entries }) +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      return false;
    }
    return false;
  }
}

function isValidTitle(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length > 0 && value === value.trim())
  );
}

function isValidTime(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isValidHeader(value: unknown): value is SavedSessionHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return (
    typeof header.id === "string" &&
    SESSION_ID_PATTERN.test(header.id) &&
    typeof header.cwd === "string" &&
    isAbsolute(header.cwd) &&
    typeof header.btime === "number" &&
    Number.isFinite(header.btime)
  );
}

function readSavedSessionHeader(fd: number): SavedSessionHeader | null {
  const header = readSessionHeader(fd);
  if (!header || header.type !== "session") return null;
  const parsed = { id: header.id, cwd: header.cwd, btime: parseEpochMs(header.timestamp) };
  return isValidHeader(parsed) ? parsed : null;
}

export function readSessionLastRun(file: string, id: string): LastRun | undefined {
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, { bigint: true });
        const size = Number(before.size);
        if (!before.isFile() || !Number.isSafeInteger(size)) return undefined;
        const header = readSessionHeader(fd);
        if (header?.type !== "session" || header.id !== id) return undefined;
        const lastRun = findLastRun(fd, size, id);
        if (
          sameFingerprint(before, fstatSync(fd, { bigint: true })) &&
          sameFingerprint(before, statSync(file, { bigint: true }))
        )
          return lastRun;
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseLastRun(value: unknown): LastRun | undefined {
  if (!isJsonObject(value)) return undefined;
  const { atMs, aborted } = value;
  if (
    typeof atMs !== "number" ||
    !Number.isSafeInteger(atMs) ||
    atMs <= 0 ||
    typeof aborted !== "boolean"
  )
    return undefined;
  return { atMs, aborted };
}

function findLastRun(fd: number, size: number, id: string): LastRun | undefined {
  const start = Math.max(0, size - LAST_RUN_SCAN_BYTES);
  for (const line of reverseLines(fd, size, start)) {
    const mayContainLastRun =
      (line.includes(LAST_RUN_CUSTOM_TYPE_BYTES) && line.includes(CUSTOM_TYPE_BYTES)) ||
      line.includes(JSON_UNICODE_ESCAPE_BYTES);
    if (!mayContainLastRun) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (
      !isJsonObject(entry) ||
      entry.type !== "custom" ||
      entry.customType !== LAST_RUN_CUSTOM_TYPE ||
      !isJsonObject(entry.data) ||
      entry.data.sessionId !== id
    )
      continue;

    const lastRun = parseLastRun(entry.data);
    if (lastRun) return lastRun;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSessionHeader(fd: number): Record<string, unknown> | undefined {
  let buffer = Buffer.allocUnsafe(SESSION_HEADER_PREFIX_BYTES);
  let length = 0;
  while (length < SESSION_HEADER_MAX_BYTES) {
    const count = readSync(fd, buffer, length, buffer.length - length, length);
    if (count === 0) break;
    const newline = buffer.subarray(length, length + count).indexOf(10);
    if (newline >= 0) {
      length += newline;
      break;
    }
    length += count;
    if (length === buffer.length && length < SESSION_HEADER_MAX_BYTES) {
      const expanded = Buffer.allocUnsafe(SESSION_HEADER_MAX_BYTES);
      buffer.copy(expanded, 0, 0, length);
      buffer = expanded;
    }
  }
  const firstLine = buffer.subarray(0, length).toString("utf8");
  try {
    const header = JSON.parse(firstLine);
    return header && typeof header === "object" && !Array.isArray(header) ? header : undefined;
  } catch {
    return undefined;
  }
}

function readSavedSessionSummary(
  fd: number,
  size: number,
  header: SavedSessionHeader | null,
): StoredSummary {
  try {
    let namedTitle: string | null | undefined;
    const scan: SummaryScan = { mtime: null, mayHaveUserMessage: false };
    for (const line of reverseSummaryLines(fd, size, scan)) {
      if (line.length === 0 || !mayContainSummaryLine(line, scan.mtime)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      if (!isJsonObject(entry)) continue;
      if (namedTitle === undefined && entry.type === "session_info") {
        namedTitle = typeof entry.name === "string" ? entry.name.trim() || null : null;
      }
      if (scan.mtime === null && (entry.type === "message" || entry.type === "compaction")) {
        scan.mtime = parseEpochMs(entry.timestamp) ?? null;
      }
      if (namedTitle !== undefined && scan.mtime !== null) break;
    }
    const title = namedTitle ?? null;
    const didStopBeforeStart = namedTitle !== undefined && scan.mtime !== null;
    const firstUser =
      didStopBeforeStart || scan.mayHaveUserMessage
        ? readFirstUserMessage(fd, size, title)
        : { title, btime: null };
    return {
      ...firstUser,
      mtime: scan.mtime,
      header,
      fingerprint: fileFingerprint(fstatSync(fd, { bigint: true })),
    };
  } catch {
    return { title: null, btime: null, mtime: null, header };
  }
}

function* forwardLines(fd: number, size: number, from = 0): Generator<Buffer, void> {
  let position = from;
  let parts: Buffer[] = [];
  while (position < size) {
    const length = Math.min(SUMMARY_READ_CHUNK_BYTES, size - position);
    const buffer = Buffer.allocUnsafe(length);
    readSummaryBytes(fd, buffer, position);
    position += length;
    let start = 0;
    let newline = buffer.indexOf(10, start);
    while (newline >= 0) {
      const prefix = buffer.subarray(start, newline);
      const line = parts.length > 0 ? Buffer.concat([...parts, prefix]) : prefix;
      yield line;
      parts = [];
      start = newline + 1;
      newline = start < length ? buffer.indexOf(10, start) : -1;
    }
    if (start < length) parts.push(buffer.subarray(start, length));
  }
  if (parts.length > 0) yield Buffer.concat(parts);
}

function readFirstUserMessage(
  fd: number,
  size: number,
  sessionTitle: string | null,
): { title: string | null; btime: number | null } {
  let title = sessionTitle;
  let btime: number | null = null;
  let firstUserFound = false;
  for (const line of forwardLines(fd, size)) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (!isJsonObject(entry) || entry.type !== "message") continue;
    const { message } = entry;
    if (!isJsonObject(message) || message.role !== "user") continue;
    if (!firstUserFound) {
      btime = parseEpochMs(entry.timestamp) ?? null;
      firstUserFound = true;
    }
    if (title === null) title = shapeFirstMessageTitle(messageText(message.content)) || null;
    if (title !== null) break;
  }
  return { title, btime };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    parts.push(record.text);
  }
  return parts.join(" ");
}

function shapeFirstMessageTitle(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return truncateCodePoints(collapsed, FIRST_MESSAGE_MAX_CODE_POINTS).trimEnd();
}

function truncateCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  let count = 0;
  while (end < text.length && count < limit) {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    count++;
  }
  return text.slice(0, end);
}

function containsSessionInfoMarker(bytes: Buffer): boolean {
  return bytes.includes(UNDERSCORE_BYTE) && bytes.includes(SESSION_INFO_TYPE_BYTES);
}

function mayContainSummaryLine(bytes: Buffer, mtime: number | null): boolean {
  return (
    mtime === null || containsSessionInfoMarker(bytes) || bytes.includes(JSON_UNICODE_ESCAPE_BYTES)
  );
}

function* reverseSummaryLines(fd: number, size: number, scan: SummaryScan): Generator<Buffer> {
  const bufferSize = Math.min(SUMMARY_READ_CHUNK_BYTES + SUMMARY_MARKER_OVERLAP_BYTES, size);
  let buffer = Buffer.allocUnsafe(bufferSize);
  let position = size;
  let lineEnd: number | undefined = size;
  let pendingCandidate = false;
  let activityLineParts: Buffer[] = [];
  while (position > 0) {
    const length = position % SUMMARY_READ_CHUNK_BYTES || SUMMARY_READ_CHUNK_BYTES;
    const endWithOverlap = Math.min(size, position + SUMMARY_MARKER_OVERLAP_BYTES);
    position -= length;
    const chunk = buffer.subarray(0, endWithOverlap - position);
    readSummaryBytes(fd, chunk, position);
    const hasLowercaseU = chunk.includes(LOWERCASE_U_BYTE);
    const hasUnicodeEscape = hasLowercaseU && chunk.includes(JSON_UNICODE_ESCAPE_BYTES);
    scan.mayHaveUserMessage ||=
      hasUnicodeEscape || (hasLowercaseU && chunk.includes(USER_ROLE_BYTES));
    if (
      scan.mtime !== null &&
      !pendingCandidate &&
      !hasUnicodeEscape &&
      !containsSessionInfoMarker(chunk)
    ) {
      lineEnd = undefined;
      continue;
    }
    const lineBytes = chunk.subarray(0, length);
    let newline = lineBytes.lastIndexOf(10);
    const suffixStart = newline + 1;
    const lineStart = position + suffixStart;
    const suffix = chunk.subarray(
      suffixStart,
      lineEnd === undefined ? chunk.length : lineEnd - position,
    );
    pendingCandidate ||= mayContainSummaryLine(suffix, scan.mtime);
    if (newline < 0) {
      if (scan.mtime === null) {
        activityLineParts.push(lineBytes);
        buffer = Buffer.allocUnsafe(bufferSize);
      }
      continue;
    }
    if (activityLineParts.length > 0) {
      yield Buffer.concat([lineBytes.subarray(suffixStart), ...activityLineParts.reverse()]);
      activityLineParts = [];
    } else if (pendingCandidate && (lineEnd === undefined || lineEnd > lineStart)) {
      if (lineEnd === undefined) {
        const line = forwardLines(fd, size, lineStart).next().value;
        if (line) yield line;
      } else {
        yield lineEnd <= endWithOverlap ? suffix : readSummaryLine(fd, lineStart, lineEnd);
      }
    }
    let end = newline;
    if (mayContainSummaryLine(lineBytes.subarray(0, end), scan.mtime)) {
      newline = end > 0 ? lineBytes.lastIndexOf(10, end - 1) : -1;
      while (newline >= 0) {
        yield lineBytes.subarray(newline + 1, end);
        end = newline;
        newline = end > 0 ? lineBytes.lastIndexOf(10, end - 1) : -1;
      }
      pendingCandidate = mayContainSummaryLine(lineBytes.subarray(0, end), scan.mtime);
    } else {
      end = lineBytes.indexOf(10);
      pendingCandidate = false;
    }
    lineEnd = position + end;
    if (scan.mtime === null && end > 0) {
      activityLineParts.push(lineBytes.subarray(0, end));
      buffer = Buffer.allocUnsafe(bufferSize);
    }
  }
  if (activityLineParts.length > 0) {
    yield Buffer.concat(activityLineParts.reverse());
  } else if (pendingCandidate) {
    if (lineEnd === undefined) {
      const line = forwardLines(fd, size).next().value;
      if (line) yield line;
    } else if (lineEnd > 0) {
      yield readSummaryLine(fd, 0, lineEnd);
    }
  }
}

function* reverseLines(fd: number, size: number, start: number): Generator<Buffer> {
  let position = size;
  let parts: Buffer[] = [];
  while (position > start) {
    const length = Math.min(SUMMARY_READ_CHUNK_BYTES, position - start);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    readSummaryBytes(fd, buffer, position);
    let end = length;
    let newline = buffer.lastIndexOf(10, end - 1);
    while (newline >= 0) {
      const suffix = buffer.subarray(newline + 1, end);
      yield parts.length > 0 ? Buffer.concat([suffix, ...parts.reverse()]) : suffix;
      parts = [];
      end = newline;
      newline = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1;
    }
    if (end > 0) parts.push(buffer.subarray(0, end));
  }
  if (start === 0 && parts.length > 0) yield Buffer.concat(parts.reverse());
}

function readSummaryLine(fd: number, start: number, end: number): Buffer {
  const line = Buffer.allocUnsafe(end - start);
  readSummaryBytes(fd, line, start);
  return line;
}

function readSummaryBytes(fd: number, buffer: Buffer, position: number): void {
  let filled = 0;
  while (filled < buffer.length) {
    const count = readSync(fd, buffer, filled, buffer.length - filled, position + filled);
    if (count === 0) throw new Error("Session changed during summary lookup");
    filled += count;
  }
}

function fileFingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function sameFingerprint(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
