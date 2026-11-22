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
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { platform } from "./platform";

const SUMMARY_READ_CHUNK_BYTES = 256 * 1024;
const SUMMARY_CACHE_VERSION = 5;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_HEADER_PREFIX_BYTES = 1024;
const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const FIRST_MESSAGE_MAX_CODE_POINTS = 80;
const SESSION_INFO_TYPE_BYTES = Buffer.from("session_info");
const JSON_UNICODE_ESCAPE_BYTES = Buffer.from("\\u");

export type SavedSessionSummary = { title: string | null; mtime: number | null };

type SavedSessionHeader = { id: string; cwd: string; btime: number };
type StoredSummary = SavedSessionSummary & {
  btime: number | null;
  header: SavedSessionHeader | null;
  fingerprint?: string;
};
type SavedSessionHistory = StoredSummary & { size: number };

export function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export class HistorySummaryCache {
  private readonly directory: string | undefined;

  constructor() {
    const configured = process.env.XDG_CACHE_HOME;
    const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
    const directory = join(root, "pi-mux", "history-titles");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (stat.isDirectory() && platform.ownedFileEntry(stat)) this.directory = directory;
    } catch {
      this.directory = undefined;
    }
  }

  resolve(file: string): SavedSessionSummary {
    const summary = this.resolveHistory(file);
    return { title: summary?.title ?? null, mtime: summary?.mtime ?? null };
  }

  resolveHistory(
    file: string,
    acceptHeader?: (header: SavedSessionHeader) => boolean,
  ): SavedSessionHistory | undefined {
    return this.resolveFile(file, this.directory, acceptHeader, true);
  }

  private resolveFile(
    file: string,
    directory: string | undefined,
    acceptHeader: ((header: SavedSessionHeader) => boolean) | undefined,
    allowsRetry: boolean,
  ): SavedSessionHistory | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) return undefined;
      const fingerprint = fileFingerprint(before);
      const path = directory
        ? join(directory, `${createHash("sha256").update(file).digest("hex")}.json`)
        : undefined;
      const cached = path ? this.load(path, file, fingerprint) : undefined;
      const header = cached ? cached.header : readSavedSessionHeader(fd);
      if (acceptHeader && (!header || !acceptHeader(header))) return undefined;
      const resolved = cached ?? readSavedSessionSummary(fd, Number(before.size), header);
      const stable =
        sameFingerprint(before, fstatSync(fd, { bigint: true })) &&
        sameFingerprint(before, statSync(file, { bigint: true }));
      if (!stable) {
        if (allowsRetry) return this.resolveFile(file, directory, acceptHeader, false);
        return { ...resolved, size: Number(before.size) };
      }
      if (!cached && path && resolved.fingerprint === fingerprint) this.save(path, file, resolved);
      return { ...resolved, size: Number(before.size) };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private load(path: string, file: string, fingerprint: string): StoredSummary | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || !platform.ownedFileEntry(stat)) return undefined;
      const entry: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const record = entry as Record<string, unknown>;
      if (
        record.version !== SUMMARY_CACHE_VERSION ||
        record.file !== file ||
        record.fingerprint !== fingerprint ||
        !isValidTitle(record.title) ||
        !isValidTime(record.btime) ||
        !isValidTime(record.mtime) ||
        !isValidHeader(record.header)
      )
        return undefined;
      return {
        title: record.title as string | null,
        btime: record.btime as number | null,
        mtime: record.mtime as number | null,
        header: record.header as SavedSessionHeader | null,
      };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private save(path: string, file: string, resolved: StoredSummary): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ version: SUMMARY_CACHE_VERSION, file, ...resolved }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, path);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        return;
      }
    }
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
    let title: string | null = null;
    let titleFound = false;
    let mtime: number | null = null;
    let mtimeFound = false;
    for (const line of reverseLines(fd, size)) {
      if (line.length === 0 || (mtimeFound && !mayContainSessionInfo(line))) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (!titleFound && record.type === "session_info") {
        title = typeof record.name === "string" ? record.name.trim() || null : null;
        titleFound = true;
      }
      if (!mtimeFound && (record.type === "message" || record.type === "compaction")) {
        const ms = parseEpochMs(record.timestamp);
        if (ms !== undefined) {
          mtime = ms;
          mtimeFound = true;
        }
      }
      if (titleFound && mtimeFound) break;
    }
    const firstUser = readFirstUserMessage(fd, size, title);
    return {
      ...firstUser,
      mtime,
      header,
      fingerprint: fileFingerprint(fstatSync(fd, { bigint: true })),
    };
  } catch {
    return { title: null, btime: null, mtime: null, header };
  }
}

function* forwardLines(fd: number, size: number): Generator<string> {
  let position = 0;
  let parts: Buffer[] = [];
  while (position < size) {
    const length = Math.min(SUMMARY_READ_CHUNK_BYTES, size - position);
    position += length;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, position - length + filled);
      if (count === 0) throw new Error("Session changed during title lookup");
      filled += count;
    }
    let start = 0;
    let newline = buffer.indexOf(10, start);
    while (newline >= 0) {
      const prefix = buffer.subarray(start, newline);
      const line = parts.length > 0 ? Buffer.concat([...parts, prefix]) : prefix;
      yield line.toString("utf8");
      parts = [];
      start = newline + 1;
      newline = start < length ? buffer.indexOf(10, start) : -1;
    }
    if (start < length) parts.push(buffer.subarray(start, length));
  }
  if (parts.length > 0) yield Buffer.concat(parts).toString("utf8");
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
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const { role, content } = message as Record<string, unknown>;
    if (role !== "user") continue;
    if (!firstUserFound) {
      btime = parseEpochMs(record.timestamp) ?? null;
      firstUserFound = true;
    }
    if (title === null) title = shapeFirstMessageTitle(messageText(content)) || null;
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

function mayContainSessionInfo(line: Buffer): boolean {
  return line.includes(SESSION_INFO_TYPE_BYTES) || line.includes(JSON_UNICODE_ESCAPE_BYTES);
}

function* reverseLines(fd: number, size: number): Generator<Buffer> {
  let position = size;
  let parts: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(SUMMARY_READ_CHUNK_BYTES, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, position + filled);
      if (count === 0) throw new Error("Session changed during summary lookup");
      filled += count;
    }
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
  if (parts.length > 0) yield Buffer.concat(parts.reverse());
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
