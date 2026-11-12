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

const SUMMARY_READ_CHUNK_BYTES = 256 * 1024;
const SUMMARY_CACHE_VERSION = 2;

export type SavedSessionSummary = { title: string | null; mtime: number | null };

type StoredSummary = SavedSessionSummary & { fingerprint?: string };

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
      if (stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0)
        this.directory = directory;
    } catch {
      this.directory = undefined;
    }
  }

  resolve(file: string): SavedSessionSummary {
    if (!this.directory) return withoutFingerprint(readSavedSessionSummary(file));
    const path = join(this.directory, `${createHash("sha256").update(file).digest("hex")}.json`);
    try {
      const before = fileFingerprint(statSync(file, { bigint: true }));
      const cached = this.load(path, file, before);
      if (cached !== undefined && before === fileFingerprint(statSync(file, { bigint: true })))
        return cached;
    } catch {
      return withoutFingerprint(readSavedSessionSummary(file));
    }
    const resolved = readSavedSessionSummary(file);
    if (resolved.fingerprint !== undefined) this.save(path, file, resolved);
    return withoutFingerprint(resolved);
  }

  private load(path: string, file: string, fingerprint: string): SavedSessionSummary | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
        return undefined;
      const entry: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const record = entry as Record<string, unknown>;
      if (
        record.version !== SUMMARY_CACHE_VERSION ||
        record.file !== file ||
        record.fingerprint !== fingerprint ||
        !isValidTitle(record.title) ||
        !isValidMtime(record.mtime)
      )
        return undefined;
      return {
        title: record.title as string | null,
        mtime: record.mtime as number | null,
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

function isValidMtime(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function withoutFingerprint(summary: StoredSummary): SavedSessionSummary {
  return { title: summary.title, mtime: summary.mtime };
}

export function readSavedSessionSummary(file: string): StoredSummary {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const before = fstatSync(fd, { bigint: true });
    let title: string | null = null;
    let titleFound = false;
    let mtime: number | null = null;
    let mtimeFound = false;
    for (const line of reverseLines(fd, Number(before.size))) {
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
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
    const fingerprint = fileFingerprint(before);
    const stable =
      fingerprint === fileFingerprint(fstatSync(fd, { bigint: true })) &&
      fingerprint === fileFingerprint(statSync(file, { bigint: true }));
    return stable ? { title, mtime, fingerprint } : { title, mtime };
  } catch {
    return { title: null, mtime: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function* reverseLines(fd: number, size: number): Generator<string> {
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
      const line = parts.length > 0 ? Buffer.concat([suffix, ...parts.reverse()]) : suffix;
      yield line.toString("utf8");
      parts = [];
      end = newline;
      newline = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1;
    }
    if (end > 0) parts.push(buffer.subarray(0, end));
  }
  if (parts.length > 0) yield Buffer.concat(parts.reverse()).toString("utf8");
}

function fileFingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
