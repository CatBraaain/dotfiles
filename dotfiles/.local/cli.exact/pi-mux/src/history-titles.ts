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

const TITLE_READ_CHUNK_BYTES = 256 * 1024;
const TITLE_CACHE_VERSION = 1;

type SavedTitle = { title: string | null; fingerprint?: string };

export class HistoryTitleCache {
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

  resolveTitle(file: string): string | null {
    if (!this.directory) return readSavedSessionTitle(file).title;
    const path = join(this.directory, `${createHash("sha256").update(file).digest("hex")}.json`);
    try {
      const before = fileFingerprint(statSync(file, { bigint: true }));
      const cached = this.load(path, file, before);
      if (cached !== undefined && before === fileFingerprint(statSync(file, { bigint: true })))
        return cached;
    } catch {
      return readSavedSessionTitle(file).title;
    }
    const resolved = readSavedSessionTitle(file);
    if (resolved.fingerprint !== undefined) this.save(path, file, resolved);
    return resolved.title;
  }

  private load(path: string, file: string, fingerprint: string): string | null | undefined {
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
        record.version !== TITLE_CACHE_VERSION ||
        record.file !== file ||
        record.fingerprint !== fingerprint
      )
        return undefined;
      if (record.title === null) return null;
      return typeof record.title === "string" &&
        record.title.length > 0 &&
        record.title === record.title.trim()
        ? record.title
        : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private save(path: string, file: string, resolved: SavedTitle): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ version: TITLE_CACHE_VERSION, file, ...resolved }) + "\n",
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

export function readSavedSessionTitle(file: string): SavedTitle {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const before = fstatSync(fd, { bigint: true });
    let title: string | null = null;
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
      if (record.type !== "session_info") continue;
      title = typeof record.name === "string" ? record.name.trim() || null : null;
      break;
    }
    const fingerprint = fileFingerprint(before);
    const stable =
      fingerprint === fileFingerprint(fstatSync(fd, { bigint: true })) &&
      fingerprint === fileFingerprint(statSync(file, { bigint: true }));
    return stable ? { title, fingerprint } : { title };
  } catch {
    return { title: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function* reverseLines(fd: number, size: number): Generator<string> {
  let position = size;
  let parts: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(TITLE_READ_CHUNK_BYTES, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, position + filled);
      if (count === 0) throw new Error("Session changed during title lookup");
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
