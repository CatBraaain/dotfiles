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
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readSessionHeader } from "./history-summary";
import { platform } from "./platform";

const CACHE_VERSION = 1;
const CHUNK_BYTES = 256 * 1024;
const BOUNDARY_BYTES = 1024;
const READ_ATTEMPTS = 3;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET_ID_PATTERN = /^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/;

type Ticket = { project: string; id: string };
type Response = { id: string; at: string };
type View = { responseId: string | null; viewedAt: string };
export type ViewReceipt = View & { file: string; fileIdentity: string };
export type UnresolvedFile = { file: string; revision: string };
type Worktrees = string[] | { invalidEntry: string };
type Summary = {
  ticket: Ticket | null;
  worktrees: Worktrees;
  response: Response | null;
  view: View | null;
};
type Checkpoint = {
  version: number;
  id: string;
  scope: string;
  directoryRevision: string;
  unresolvedFiles: UnresolvedFile[];
  file: string;
  identity: string;
  revision: string;
  size: number;
  offset: number;
  boundary: string;
  summary: Summary;
};

export class SessionPathChangedError extends Error {}

export class SessionMetadataCache {
  private readonly cacheFile: string | undefined;

  constructor(
    private readonly id: string,
    private readonly scope: string,
    private readonly directoryRevision: string,
  ) {
    const xdg = process.env.XDG_CACHE_HOME;
    const root = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
    const directory = join(root, "pi-mux", "session-metadata");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (stat.isDirectory() && platform.ownedFileEntry(stat))
        this.cacheFile = join(directory, `${sha256(JSON.stringify([id, scope]))}.json`);
    } catch {
      this.cacheFile = undefined;
    }
  }

  async read(
    locate: (unresolvedFiles: UnresolvedFile[]) => Promise<string | undefined>,
  ): Promise<Checkpoint> {
    const previous = this.load();
    if (
      previous &&
      previous.directoryRevision === this.directoryRevision &&
      previous.unresolvedFiles.every(
        (candidate) => metadataFileRevision(candidate.file) === candidate.revision,
      )
    ) {
      const checkpoint = this.readFile(previous.file, previous);
      if (checkpoint) {
        if (checkpoint !== previous)
          this.save({ ...checkpoint, unresolvedFiles: previous.unresolvedFiles });
        return checkpoint;
      }
    }
    const unresolvedFiles: UnresolvedFile[] = [];
    const file = await locate(unresolvedFiles);
    if (!file) throw new Error(`Saved session not found (use the complete ID): ${this.id}`);
    const checkpoint = this.readFile(file, previous?.file === file ? previous : undefined);
    if (!checkpoint)
      throw new SessionPathChangedError(`Saved session changed during lookup: ${this.id}`);
    const resolved = { ...checkpoint, directoryRevision: this.directoryRevision, unresolvedFiles };
    this.save(resolved);
    return resolved;
  }

  private readFile(file: string, previous?: Checkpoint): Checkpoint | undefined {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      let fd: number;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
          return undefined;
        throw error;
      }
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()) return undefined;
        const checkpoint = this.reduceFile(fd, file, before, previous);
        const onDisk = lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (
          onDisk?.isFile() &&
          revision(before) === revision(onDisk) &&
          revision(before) === revision(fstatSync(fd, { bigint: true }))
        )
          return checkpoint;
      } finally {
        closeSync(fd);
      }
    }
    throw new Error(`Session history did not stabilize: ${file}`);
  }

  private reduceFile(fd: number, file: string, before: BigIntStats, previous?: Checkpoint) {
    const stamp = revision(before);
    if (previous?.revision === stamp) return previous;

    const header = readSessionHeader(fd);
    if (header?.type !== "session" || header.id !== this.id || !absolutePath(header.cwd)) return;

    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new Error(`Session file is too large: ${file}`);
    const canResume =
      previous !== undefined &&
      previous.identity === identity(before) &&
      size > previous.size &&
      boundaryHash(fd, previous.offset) === previous.boundary;
    const summary: Summary = canResume
      ? { ...previous.summary }
      : {
          ticket: null,
          worktrees: [],
          response: null,
          view: null,
        };
    const start = canResume ? previous.offset : 0;
    const offset = scanCompleteLines(fd, start, size, (line) => {
      const entry = parseLine(line);
      if (entry) applyEntry(summary, this.id, entry);
    });
    return {
      version: CACHE_VERSION,
      id: this.id,
      scope: this.scope,
      directoryRevision: this.directoryRevision,
      unresolvedFiles: [],
      file,
      identity: identity(before),
      revision: stamp,
      size,
      offset,
      boundary: boundaryHash(fd, offset),
      summary,
    };
  }

  private load(): Checkpoint | undefined {
    if (!this.cacheFile) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(
        this.cacheFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = fstatSync(fd);
      if (!stat.isFile() || !platform.ownedFileEntry(stat)) return undefined;
      const cached: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!isCheckpoint(cached) || cached.id !== this.id || cached.scope !== this.scope)
        return undefined;
      return cached;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private save(checkpoint: Checkpoint): void {
    if (!this.cacheFile) return;
    const temporary = `${this.cacheFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.cacheFile);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        return;
      }
    }
  }
}

export function sessionMetadata(id: string, summary: Summary) {
  if (!Array.isArray(summary.worktrees))
    throw new Error(`Invalid workspaces in custom entry ${summary.worktrees.invalidEntry}`);
  const responseId = summary.response?.id ?? null;
  return {
    id,
    ticket: summary.ticket,
    worktrees: summary.worktrees,
    updatedAt: summary.response?.at ?? null,
    viewedAt: summary.view?.viewedAt ?? null,
    unread: summary.view ? summary.view.responseId !== responseId : null,
  };
}

export function isViewReceipt(value: unknown): value is ViewReceipt {
  return (
    isRecord(value) &&
    absolutePath(value.file) &&
    typeof value.fileIdentity === "string" &&
    /^\d+:\d+:-?\d+$/.test(value.fileIdentity) &&
    isView(value)
  );
}

export function metadataFileIdentity(file: string): string | undefined {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? identity(stat) : undefined;
}

export function metadataFileRevision(file: string): string | undefined {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? revision(stat) : undefined;
}

function isView(value: unknown): value is View {
  return (
    isRecord(value) &&
    (value.responseId === null || isEntryId(value.responseId)) &&
    isIsoTime(value.viewedAt)
  );
}

function applyEntry(summary: Summary, id: string, entry: Record<string, unknown>): void {
  const response = textResponse(entry);
  if (response) {
    summary.response = response;
    return;
  }
  if (entry.type !== "custom" || !isRecord(entry.data) || entry.data.sessionId !== id) return;
  const payload = entry.data;
  if (entry.customType === "session-worktree-metadata") {
    summary.worktrees = isWorktrees(payload.workspaces)
      ? payload.workspaces
      : {
          invalidEntry: typeof entry.id === "string" ? entry.id : "unknown",
        };
  } else if (entry.customType === "pi-mux-ticket" && isTicket(payload.ticket)) {
    summary.ticket = payload.ticket;
  } else if (entry.customType === "pi-mux-viewed" && isView(payload)) {
    if (summary.view === null || Date.parse(payload.viewedAt) >= Date.parse(summary.view.viewedAt))
      summary.view = { responseId: payload.responseId, viewedAt: payload.viewedAt };
  }
}

function textResponse(entry: Record<string, unknown>): Response | undefined {
  if (
    entry.type !== "message" ||
    !isEntryId(entry.id) ||
    !isRecord(entry.message) ||
    entry.message.role !== "assistant" ||
    !Array.isArray(entry.message.content)
  )
    return;
  const hasText = entry.message.content.some(
    (block) =>
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim(),
  );
  if (!hasText || typeof entry.timestamp !== "string") return;
  const timestamp = Date.parse(entry.timestamp);
  if (Number.isFinite(timestamp)) return { id: entry.id, at: new Date(timestamp).toISOString() };
}

function parseLine(line: Buffer): Record<string, unknown> | undefined {
  if (!line.length || line[0] === 13) return;
  try {
    const entry: unknown = JSON.parse(line.toString("utf8"));
    if (isRecord(entry)) return entry;
  } catch {
    return undefined;
  }
}

function scanCompleteLines(
  fd: number,
  start: number,
  size: number,
  visit: (line: Buffer) => void,
): number {
  let offset = start;
  let fragments: Buffer[] = [];
  for (let position = start; position < size;) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position));
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (read === 0) break;
    const bytes = chunk.subarray(0, read);
    let lineStart = 0;
    for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, lineStart)) {
      const part = bytes.subarray(lineStart, newline);
      visit(fragments.length ? Buffer.concat([...fragments, part]) : part);
      fragments = [];
      lineStart = newline + 1;
      offset = position + lineStart;
    }
    if (lineStart < read) fragments.push(bytes.subarray(lineStart));
    position += read;
  }
  return offset;
}

function boundaryHash(fd: number, offset: number): string {
  const length = Math.min(BOUNDARY_BYTES, offset);
  const bytes = Buffer.allocUnsafe(length);
  const read = readSync(fd, bytes, 0, length, offset - length);
  return sha256(bytes.subarray(0, read));
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs].join(":");
}

function revision(stat: BigIntStats): string {
  return [identity(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID_PATTERN.test(value);
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function isTicket(value: unknown): value is Ticket {
  if (!isRecord(value)) return false;
  const { project, id } = value;
  return (
    typeof project === "string" &&
    !!project &&
    project !== "." &&
    project !== ".." &&
    !/[/\\\0]/.test(project) &&
    typeof id === "string" &&
    id.length <= 252 &&
    TICKET_ID_PATTERN.test(id)
  );
}

function isWorktrees(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(absolutePath) && new Set(value).size === value.length;
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!isRecord(value) || !isRecord(value.summary)) return false;
  const { ticket, worktrees, response, view } = value.summary;
  const { size, offset } = value;
  return (
    value.version === CACHE_VERSION &&
    typeof value.id === "string" &&
    typeof value.scope === "string" &&
    typeof value.directoryRevision === "string" &&
    Array.isArray(value.unresolvedFiles) &&
    value.unresolvedFiles.every(
      (candidate) =>
        isRecord(candidate) &&
        absolutePath(candidate.file) &&
        typeof candidate.revision === "string",
    ) &&
    absolutePath(value.file) &&
    typeof value.revision === "string" &&
    typeof value.identity === "string" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof offset === "number" &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= size &&
    typeof value.boundary === "string" &&
    /^[a-f0-9]{64}$/.test(value.boundary) &&
    (ticket === null || isTicket(ticket)) &&
    (isWorktrees(worktrees) ||
      (isRecord(worktrees) && typeof worktrees.invalidEntry === "string")) &&
    (response === null ||
      (isRecord(response) && isEntryId(response.id) && isIsoTime(response.at))) &&
    (view === null || isView(view))
  );
}
