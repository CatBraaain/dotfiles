import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type LockHistoryTarget = { project: string; ticketId: string; cwd: string };
export type LockHistoryOwner = { ownerId: string; file: string };

type Header = { ownerId: string; createdAtMs: number; parentSession?: string };
type TicketCall = {
  id: string;
  timestamp: string;
  entryId: string;
  timestampMs: number;
  arguments: Record<string, unknown>;
};
type TicketUpdate = {
  key: string;
  fingerprint: string;
  callAtMs: number;
  resultAtMs: number;
  order: number;
  locks: boolean;
};
type Session = { header: Header; updates: Map<string, TicketUpdate> };
type CachedSession = { revision: string; session?: Session };
class SessionChanged extends Error {}
type LocatedUpdate = { file: string; update: TicketUpdate };

const SCAN_CONCURRENCY = 8;
const MAX_FILE_READ_ATTEMPTS = 2;
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const STATUSES = new Set(["draft", "open", "blocked", "locked", "closed", "cancelled"]);
const ENTRY_PREFIX =
  /^\{"type":"([^"\\]+)","id":"([\w-]+)","parentId":("[\w-]+"|null),"timestamp":"[^"\\]+"(?:,"message":\{"role":"([^"\\]+)")?/;

export class LockHistory {
  private readonly cache = new Map<string, CachedSession>();

  constructor(private readonly home = homedir()) {}

  async findOwners(targets: readonly LockHistoryTarget[]): Promise<{
    owners: ReadonlyMap<string, LockHistoryOwner>;
    isOwnerFileCurrent(owner: LockHistoryOwner): Promise<boolean>;
  }> {
    const files =
      targets.length === 0
        ? []
        : await sessionFiles(
            targets.map(({ cwd }) => cwd),
            this.home,
          );
    const sessions = new Map<string, Session>();
    const store = join(this.home, ".agents", "tickets");
    let failure: unknown;
    for (let index = 0; index < files.length; index += SCAN_CONCURRENCY) {
      const batch = files.slice(index, index + SCAN_CONCURRENCY);
      const parsed = await Promise.allSettled(
        batch.map((file) => this.readStableSession(file, store)),
      );
      for (const result of parsed) {
        if (result.status === "rejected") {
          failure ??= result.reason;
          continue;
        }
        const [file, contents] = result.value;
        if (contents) sessions.set(file, contents);
      }
    }
    const discovered = new Set(files);
    for (const file of this.cache.keys()) {
      if (!discovered.has(file)) this.cache.delete(file);
    }
    if (failure !== undefined) throw failure;

    const keys = new Set(targets.map(({ project, ticketId }) => `${project}/${ticketId}`));
    const owners = selectOwners(sessions, keys);
    const revisions = new Map(
      [...owners.values()].map(({ file }) => [file, this.cache.get(file)?.revision]),
    );
    return {
      owners,
      async isOwnerFileCurrent({ file }) {
        try {
          const expected = revisions.get(file);
          return (
            expected !== undefined &&
            fileRevision(await lstat(file, { bigint: true }), store) === expected
          );
        } catch {
          return false;
        }
      },
    };
  }

  private async readStableSession(file: string, store: string): Promise<[string, Session?]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readSession(file, store);
      } catch (error) {
        const mayHaveChanged =
          error instanceof SessionChanged || (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!mayHaveChanged || attempt >= MAX_FILE_READ_ATTEMPTS) throw error;
      }
    }
  }

  private async readSession(file: string, store: string): Promise<[string, Session?]> {
    const entry = await lstat(file, { bigint: true });
    if (!entry.isFile()) throw new SessionChanged(`Session is no longer a file: ${file}`);
    const revision = fileRevision(entry, store);
    const cached = this.cache.get(file);
    if (cached?.revision === revision) return [file, cached.session];

    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const input = handle.createReadStream({ autoClose: false });
    try {
      if (fileRevision(await handle.stat({ bigint: true }), store) !== revision) {
        throw new SessionChanged(`Session changed before reading: ${file}`);
      }
      const lines = createInterface({ input, crlfDelay: Infinity });
      const session = await scanEntries(lines, store);
      if (fileRevision(await lstat(file, { bigint: true }), store) !== revision) {
        throw new SessionChanged(`Session changed while reading: ${file}`);
      }
      this.cache.set(file, { revision, session });
      return [file, session];
    } finally {
      input.destroy();
      await handle.close();
    }
  }
}

function fileRevision(
  entry: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint; size: bigint },
  store: string,
): string {
  return `${entry.dev}:${entry.ino}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.size}:${store}`;
}

async function sessionFiles(cwds: string[], home: string): Promise<string[]> {
  const agent = expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent", process.cwd(), home);
  const normal = join(agent, "sessions");
  const groups = (await directoryEntries(normal))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"),
    )
    .map((entry) => join(normal, entry.name));
  const override = process.env.PI_CODING_AGENT_SESSION_DIR;
  const global = override ? undefined : await sessionDirSetting(join(agent, "settings.json"));
  const custom = await Promise.all(
    [...new Set(cwds)].map(async (cwd) => {
      if (!isAbsolute(cwd)) throw new Error(`Invalid target cwd: ${cwd}`);
      const path =
        override || (await sessionDirSetting(join(cwd, ".pi", "settings.json"))) || global;
      return path ? expandPath(path, cwd, home) : undefined;
    }),
  );
  const directories = new Set([...groups, ...custom.filter((path) => path !== undefined)]);
  const files = new Set<string>();
  for (const directory of directories) {
    const entries = await directoryEntries(directory);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(join(directory, entry.name));
      if (entry.name !== "archive") continue;
      if (!entry.isDirectory()) throw new Error(`Invalid session archive in ${directory}`);
      const archive = join(directory, entry.name);
      for (const archived of await directoryEntries(archive)) {
        if (archived.isFile() && archived.name.endsWith(".jsonl"))
          files.add(join(archive, archived.name));
      }
    }
  }
  return [...files];
}

function directoryEntries(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function sessionDirSetting(path: string): Promise<string | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const settings = record(Bun.JSONC.parse(text));
  if (!settings || (settings.sessionDir !== undefined && typeof settings.sessionDir !== "string")) {
    throw new Error(`Invalid session settings: ${path}`);
  }
  return settings.sessionDir;
}

function expandPath(path: string, cwd: string, home: string): string {
  if (path.startsWith("file://")) return fileURLToPath(path);
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(cwd, path);
}

async function scanEntries(
  lines: AsyncIterable<string>,
  store: string,
): Promise<Session | undefined> {
  let header: Header | undefined;
  let order = 0;
  const activeCalls = new Map<string, Map<string, TicketCall>>();
  const updates = new Map<string, TicketUpdate>();
  for await (const line of lines) {
    if (order++ === 0) {
      header = parseHeader(line);
      if (!header) return undefined;
      continue;
    }
    const mentionsTicketTool = line.includes('"ticket_set"');
    if (activeCalls.size === 0 && !mentionsTicketTool) continue;
    const prefix = ENTRY_PREFIX.exec(line);
    const prefixRole = prefix?.[4];
    const needsBody =
      !prefix ||
      (prefix[1] === "message" &&
        (!prefixRole ||
          (mentionsTicketTool && (prefixRole === "assistant" || prefixRole === "toolResult"))));
    const entry = needsBody ? parseRecord(line) : undefined;
    const message = record(entry?.message);
    const type = entry?.type ?? prefix?.[1];
    const role = type === "message" ? (message?.role ?? prefix?.[4]) : undefined;
    const entryId = entry?.id ?? prefix?.[2];
    if (typeof entryId !== "string") continue;

    if (role === "assistant") {
      const calls = readCalls(entryId, entry?.timestamp, message?.content);
      if (calls.size > 0) activeCalls.set(entryId, calls);
      continue;
    }
    const parentId = entry
      ? entry.parentId
      : prefix?.[3]?.startsWith('"')
        ? prefix[3].slice(1, -1)
        : null;
    const calls = typeof parentId === "string" ? activeCalls.get(parentId) : undefined;
    if (!calls) continue;
    activeCalls.set(entryId, calls);
    if (role !== "toolResult" || message?.toolName !== "ticket_set" || message.isError !== false)
      continue;
    const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
    if (!call || entry?.type !== "message") continue;
    const update = readUpdate(
      call,
      { entryId, timestamp: entry.timestamp, content: message.content, order },
      store,
    );
    if (update) updates.set(update.fingerprint, update);
  }
  return header ? { header, updates } : undefined;
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function parseHeader(line: string): Header | undefined {
  const header = parseRecord(line);
  if (header?.type !== "session" || typeof header.id !== "string" || !SESSION_ID.test(header.id))
    return;
  const createdAtMs = timestampMs(header.timestamp);
  if (createdAtMs === undefined) return;
  if (
    header.parentSession !== undefined &&
    (typeof header.parentSession !== "string" || !isAbsolute(header.parentSession))
  )
    return;
  return { ownerId: header.id, createdAtMs, parentSession: header.parentSession };
}

function timestampMs(input: unknown): number | undefined {
  if (typeof input !== "string") return undefined;
  const ms = Date.parse(input);
  return Number.isFinite(ms) && new Date(ms).toISOString() === input ? ms : undefined;
}

function readCalls(entryId: string, timestamp: unknown, content: unknown): Map<string, TicketCall> {
  const calls = new Map<string, TicketCall>();
  if (typeof timestamp !== "string" || !Array.isArray(content)) return calls;
  const callAtMs = timestampMs(timestamp);
  if (callAtMs === undefined) return calls;
  for (const block of content) {
    const call = record(block);
    if (call?.type !== "toolCall" || call.name !== "ticket_set" || typeof call.id !== "string")
      continue;
    const args = record(call.arguments);
    if (args)
      calls.set(call.id, {
        id: call.id,
        entryId,
        timestamp,
        timestampMs: callAtMs,
        arguments: args,
      });
  }
  return calls;
}

function readUpdate(
  call: TicketCall,
  result: { entryId: string; timestamp: unknown; content: unknown; order: number },
  store: string,
): TicketUpdate | undefined {
  const resultAtMs = timestampMs(result.timestamp);
  if (
    resultAtMs === undefined ||
    resultAtMs < call.timestampMs ||
    !Array.isArray(result.content) ||
    result.content.length !== 1
  )
    return;
  const block = record(result.content[0]);
  if (block?.type !== "text" || typeof block.text !== "string") return;
  const match =
    /^updated ([^\r\n]+)\r?\nstatus: ([a-z]+)\r?\nafter: [^\r\n]+\r?\npath: ([^\r\n]+)(?:\r?\n)?$/.exec(
      block.text,
    );
  const [, id, status, path] = match ?? [];
  if (
    !id ||
    !validPathSegment(id) ||
    !status ||
    !STATUSES.has(status) ||
    !path ||
    !isAbsolute(path)
  )
    return;
  const project = basename(dirname(path));
  if (!validPathSegment(project) || path !== join(store, project, `${id}.md`)) return;
  if (call.arguments.project !== undefined && call.arguments.project !== project) return;
  const locks = status === "locked";
  if (locks && call.arguments.status !== "locked") return;
  const key = `${project}/${id}`;
  const fingerprint = JSON.stringify([
    key,
    status,
    call.entryId,
    call.timestamp,
    call.id,
    result.entryId,
    result.timestamp,
  ]);
  return { key, fingerprint, callAtMs: call.timestampMs, resultAtMs, order: result.order, locks };
}

function validPathSegment(input: string): boolean {
  return input !== "." && input !== ".." && !/[/\\\0]/.test(input);
}

function selectOwners(
  sessions: ReadonlyMap<string, Session>,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, LockHistoryOwner> {
  const latest = new Map<string, LocatedUpdate[]>();
  for (const [file, session] of sessions) {
    for (const update of session.updates.values()) {
      if (!keys.has(update.key)) continue;
      const current = latest.get(update.key);
      const currentAtMs = current?.[0]?.update.resultAtMs;
      if (currentAtMs === undefined || update.resultAtMs > currentAtMs) {
        latest.set(update.key, [{ file, update }]);
      } else if (update.resultAtMs === currentAtMs) {
        current?.push({ file, update });
      }
    }
  }

  const owners = new Map<string, LockHistoryOwner>();
  for (const [key, updates] of latest) {
    let winner: LocatedUpdate | undefined;
    for (const update of updates) {
      const original = findOrigin(update, sessions);
      if (!original || (winner && winner.file !== original.file)) {
        winner = undefined;
        break;
      }
      if (!winner || original.update.order > winner.update.order) winner = original;
    }
    const session = winner && sessions.get(winner.file);
    if (winner?.update.locks && session)
      owners.set(key, { ownerId: session.header.ownerId, file: winner.file });
  }
  return owners;
}

function findOrigin(
  located: LocatedUpdate,
  sessions: ReadonlyMap<string, Session>,
): LocatedUpdate | undefined {
  const visited = new Set<string>();
  let { file, update } = located;
  while (!visited.has(file)) {
    visited.add(file);
    const session = sessions.get(file);
    if (!session) return;
    const { parentSession, createdAtMs } = session.header;
    if (!parentSession) {
      return update.callAtMs >= createdAtMs
        ? preferNormalCopy({ file, update }, session, sessions)
        : undefined;
    }
    const parentFile = savedParent(parentSession, sessions);
    const parent = parentFile ? sessions.get(parentFile) : undefined;
    const inherited = parent?.updates.get(update.fingerprint);
    if (!parentFile || !parent || !inherited) {
      return update.callAtMs > createdAtMs
        ? preferNormalCopy({ file, update }, session, sessions)
        : undefined;
    }
    if (parent.header.createdAtMs > createdAtMs) return;
    file = parentFile;
    update = inherited;
  }
}

function preferNormalCopy(
  located: LocatedUpdate,
  archived: Session,
  sessions: ReadonlyMap<string, Session>,
): LocatedUpdate {
  const directory = dirname(located.file);
  if (basename(directory) !== "archive") return located;
  const normalFile = join(dirname(directory), basename(located.file));
  const normal = sessions.get(normalFile);
  if (
    normal?.header.ownerId !== archived.header.ownerId ||
    normal.header.createdAtMs !== archived.header.createdAtMs ||
    normal.header.parentSession !== archived.header.parentSession
  )
    return located;
  const update = normal.updates.get(located.update.fingerprint);
  return update ? { file: normalFile, update } : located;
}

function savedParent(path: string, sessions: ReadonlyMap<string, Session>): string | undefined {
  const normalized = resolve(path);
  if (sessions.has(normalized)) return normalized;
  const directory = dirname(normalized);
  const alternative =
    basename(directory) === "archive"
      ? join(dirname(directory), basename(normalized))
      : join(directory, "archive", basename(normalized));
  return sessions.has(alternative) ? alternative : undefined;
}
