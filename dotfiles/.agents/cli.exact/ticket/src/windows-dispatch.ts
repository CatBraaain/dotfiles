import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { Database, SQLiteError } from "bun:sqlite";

export const WORKER_TOKEN_ENV = "TICKET_DISPATCH_WORKER_TOKEN";
const SOCKET_ENV = "TICKET_DISPATCH_WORKER_SOCKET";
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const GENERATION = /^[0-9a-f]{16}$/;
const IO_TIMEOUT_MS = 8_000;
const ACTIVATION_TIMEOUT_MS = 30_000;
const POLL_MS = 25;

interface WorkerRight {
  token: string;
  project: string | null;
  name: string;
  generation: string;
  created: number;
  peer?: string;
  state: "reserved" | "revoked" | "claimed" | "active";
}

export type WorkerEntry = Pick<WorkerRight, "project" | "name" | "created">;

type BoundWorker = { peer?: string; isAlive(): boolean; stop(): void; close(): Promise<void> };

type WorkerObservation =
  | { state: "bound"; connection: BoundWorker }
  | { state: "gone" | "unknown" };

type BoundObservation =
  | Exclude<WorkerObservation, { state: "gone" | "unknown" }>
  | { state: "other" | "unknown" };

type WorkerRuntime = {
  management(socket: string): Promise<string>;
  create(socket: string, right: WorkerRight, command: string[]): Promise<void>;
  observe(socket: string, right: WorkerRight): Promise<WorkerObservation>;
  activationTimeout: number;
  stopTimeout: number;
};

export function windowsPsmuxEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:TMUX(?:_PANE)?|PSMUX_TARGET_SESSION|PSMUX_TARGET_FULL|PSMUX_ROUTE_WARM)$/i.test(key))
      delete env[key];
  }
  return env;
}

export async function runWindowsInspection(args: string[], timeout?: number) {
  const child = Bun.spawn(["pi-mux", "inspect", ...args], {
    env: windowsPsmuxEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function requireWindowsManagement(socket: string): Promise<string> {
  const result = await runWindowsInspection(["--management", socket], IO_TIMEOUT_MS);
  if (result.exitCode !== 0)
    throw new Error("Windows pi-mux management is not ready: " + result.stderr.trim());
  const value = JSON.parse(result.stdout);
  if (
    value?.state !== "ready" ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation)
  )
    throw new Error("Cannot verify the active restored Windows pi-mux management generation");
  return value.generation;
}

export function windowsDispatchDirectory(socket: string): string {
  const { root, namespace } = windowsDispatchAddress(socket);
  return join(root, "ticket-dispatch", Buffer.from(namespace.toLowerCase()).toString("hex"));
}

function windowsDispatchAddress(socket: string) {
  const root = process.env.PSMUX_DATA_DIR ?? join(process.env.USERPROFILE || homedir(), ".psmux");
  if (!win32.isAbsolute(root) || !win32.isAbsolute(socket))
    throw new Error("Windows psmux registry and socket paths must be absolute");
  const path = normalizeWindowsPath(socket);
  const prefix = normalizeWindowsPath(root).replace(/\\$/, "") + "\\";
  const label = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  const legacyLabel = /^\/tmp\/psmux-\d+\/([^/\\]+)$/.exec(socket)?.[1];
  const namespace =
    legacyLabel ??
    (label && !label.includes("\\") ? win32.basename(socket) : hashedSocketNamespace(path));
  return { root, namespace };
}

function normalizeWindowsPath(path: string): string {
  return win32
    .resolve(path)
    .replace(/^\\\\\?\\/, "")
    .replace(/\\$/, "")
    .toLowerCase();
}

function hashedSocketNamespace(path: string): string {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of Buffer.from(path))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x0000_0100_0000_01b3n);
  return `sock-${hash.toString(16).padStart(16, "0")}`;
}

function powershellLiteral(value: string): string {
  return "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
}

async function createWorkerSession(
  socket: string,
  right: WorkerRight,
  command: string[],
): Promise<void> {
  const environment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    PSMUX_DATA_DIR: process.env.PSMUX_DATA_DIR,
    TICKET_TEST_TICK_MS: process.env.TICKET_TEST_TICK_MS,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    [SOCKET_ENV]: socket,
  };
  const setup = Object.entries(environment).map(([key, value]) =>
    value ? `$env:${key} = ${powershellLiteral(value)}` : `$env:${key} = $null`,
  );
  const invoke = `& ${command.map(powershellLiteral).join(" ")}`;
  const encoded = Buffer.from(
    [...setup, invoke, "exit $LASTEXITCODE"].join("; "),
    "utf16le",
  ).toString("base64");
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await runWindowsInspection([
    "--create-dispatch-worker",
    socket,
    right.generation,
    right.name,
    right.project ?? "",
    right.token,
    process.cwd(),
    powershell,
    encoded,
  ]);
  if (result.exitCode !== 0)
    throw new Error("dispatcher start failed for " + right.name + ": " + result.stderr.trim());
}

const PEER_IDENTITY = /^[1-9]\d*:[1-9]\d*$/;

function workerRegistryIdentity(socket: string, name: string): string | "partial" | undefined {
  const { root, namespace } = windowsDispatchAddress(socket);
  const base = namespace === "default" ? name : namespace + "__" + name;
  const entries = new Set(readdirSync(root).map((entry) => entry.toLowerCase()));
  const relevant = ["pid", "port", "key", "sid"].filter((extension) =>
    entries.has((base + "." + extension).toLowerCase()),
  );
  if (relevant.length === 0) return;
  if (!["pid", "port", "key"].every((extension) => relevant.includes(extension))) return "partial";
  try {
    const identity = readFileSync(join(root, base + ".pid"), "utf8").trim();
    return PEER_IDENTITY.test(identity) ? identity : "partial";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "partial";
    throw error;
  }
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function openWindowsProcessApi() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
}

let processApi: ReturnType<typeof openWindowsProcessApi> | undefined;

function previousPeerEnded(peer: string | undefined): boolean {
  if (!peer) return true;
  const [pid, created] = peer.split(":");
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0 || processId > 0xffffffff) return false;
  const api = (processApi ??= openWindowsProcessApi());
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, processId);
  if (!handle) return api.GetLastError() === ERROR_INVALID_PARAMETER;
  try {
    const times = Buffer.alloc(32);
    const ok = api.GetProcessTimes(
      handle,
      ptr(times),
      ptr(times, 8),
      ptr(times, 16),
      ptr(times, 24),
    );
    const wait = api.WaitForSingleObject(handle, 0);
    if (wait === WAIT_OBJECT_0) return true;
    const observed = times.readBigUInt64LE();
    return !!ok && wait === WAIT_TIMEOUT && observed > 0n && observed.toString() !== created;
  } finally {
    api.CloseHandle(handle);
  }
}

async function observeWorker(socket: string, right: WorkerRight): Promise<WorkerObservation> {
  if (right.peer && previousPeerEnded(right.peer)) return { state: "gone" };
  const unclaimed = right.state === "reserved" || right.state === "revoked";
  const before = workerRegistryIdentity(socket, right.name);
  if (!before) return { state: unclaimed ? "gone" : "unknown" };
  if (before === "partial") return { state: "unknown" };
  const observation = await bindWorker(socket, right);
  const after = workerRegistryIdentity(socket, right.name);
  if (observation.state === "bound") {
    if (before === after && (!right.peer || right.peer === before))
      return { state: "bound", connection: { ...observation.connection, peer: before } };
    await observation.connection.close();
  }
  const differentWorker = observation.state === "other" && before === after && right.peer !== after;
  if ((!after || differentWorker) && (right.peer ? previousPeerEnded(right.peer) : unclaimed))
    return { state: "gone" };
  return { state: "unknown" };
}

async function bindWorker(socket: string, right: WorkerRight): Promise<BoundObservation> {
  const client = Bun.spawn(
    ["psmux.exe", "-S", socket, "-f", "NUL", "-C", "attach-session", "-t", `=${right.name}`],
    {
      env: windowsPsmuxEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    },
  );
  const query = "show-environment " + WORKER_TOKEN_ENV;
  const verify = workerResponseVerifier(query, WORKER_TOKEN_ENV + "=" + right.token);
  let verified: "owned" | "other" | "unknown" | undefined;
  const consume = (async () => {
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of client.stdout) {
      const lines = (carry + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) verified ??= verify(line);
      if (carry.length > 256 * 1024) verified = "unknown";
    }
  })().catch(() => {
    verified = "unknown";
  });
  async function close() {
    if (client.exitCode === null) client.kill();
    await client.exited;
    await consume;
  }
  try {
    client.stdin.write(query + "\n");
    client.stdin.flush();
    await poll(() => verified !== undefined || client.exitCode !== null, IO_TIMEOUT_MS);
    if (verified === "owned" && client.exitCode === null) {
      const connection = {
        isAlive: () => client.exitCode === null,
        stop() {
          if (client.exitCode !== null) return;
          client.stdin.write("kill-session\n");
          client.stdin.flush();
        },
        close,
      };
      return { state: "bound", connection };
    }
  } catch (error) {
    const exited = client.exitCode !== null;
    await close();
    if (!exited) throw error;
    return { state: "unknown" };
  }
  await close();
  return { state: verified === "other" ? "other" : "unknown" };
}

export function workerResponseVerifier(query: string, tokenLine: string) {
  let queryEchoed = false;
  let response: string | undefined;
  const body: string[] = [];
  const separator = tokenLine.indexOf("=");
  const key = tokenLine.slice(0, separator);
  return function verify(line: string): "owned" | "other" | "unknown" | undefined {
    if (line === query) queryEchoed = true;
    if (!queryEchoed) return;
    if (!response) {
      if (line.startsWith("%begin ")) response = line.slice(7);
      return;
    }
    if (line === "%error " + response) {
      if (body.length === 1 && body[0] === "unknown variable: " + key) return "other";
      return "unknown";
    }
    if (line === "%end " + response) {
      if (body.length !== 1) return "unknown";
      const value = body[0]!;
      if (value === tokenLine) return "owned";
      if (value === "-" + key || value.startsWith(key + "=")) return "other";
      return "unknown";
    }
    if (body.length > 0) return "unknown";
    body.push(line);
  };
}

async function poll(condition: () => boolean, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

function scope(project: string | null): string {
  return project === null ? "all" : `project:${project.toLowerCase()}`;
}

function leasePath(directory: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error("Invalid Windows dispatcher worker token");
  return join(directory, `${token}.sqlite`);
}

function isBusy(error: unknown): boolean {
  return error instanceof SQLiteError && error.code === "SQLITE_BUSY";
}

async function runClaimTransaction(
  database: Database,
  command: "BEGIN IMMEDIATE" | "COMMIT",
): Promise<void> {
  const deadline = Date.now() + IO_TIMEOUT_MS;
  for (;;) {
    try {
      database.exec(command);
      return;
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for Windows dispatcher claim lock");
      await Bun.sleep(POLL_MS);
    }
  }
}

const windowsWorkerRuntime: WorkerRuntime = {
  management: requireWindowsManagement,
  create: createWorkerSession,
  observe: observeWorker,
  activationTimeout: ACTIVATION_TIMEOUT_MS,
  stopTimeout: IO_TIMEOUT_MS,
};

export class WindowsWorkerRights {
  constructor(
    private readonly directory: string,
    private readonly runtime = windowsWorkerRuntime,
  ) {}

  async start(
    socket: string,
    worker: Pick<WorkerRight, "project" | "name" | "generation">,
    command: string[],
  ): Promise<boolean> {
    const { project, name } = worker;
    const previous = await this.checkOverlaps(socket, project);
    const restarted = previous ? await this.retire(socket, previous) : false;
    const right: WorkerRight = {
      ...worker,
      token: randomUUID(),
      created: Math.floor(Date.now() / 1000),
      state: "reserved",
    };
    await this.write((database) => {
      database.run("INSERT INTO rights (scope, record) VALUES (?, ?)", [
        scope(project),
        JSON.stringify(right),
      ]);
    });
    try {
      if ((await this.runtime.management(socket)) !== right.generation)
        throw new Error("Windows pi-mux management changed before dispatcher creation");
      await this.runtime.create(socket, right, command);
      if (
        !(await poll(() => this.read(project)?.state === "claimed", this.runtime.activationTimeout))
      )
        throw new Error(`dispatcher worker did not claim its launch right: ${name}`);
      const observed = await this.runtime.observe(socket, right);
      if (observed.state !== "bound")
        throw new Error(`cannot verify dispatcher worker session: ${name}`);
      const bound = observed.connection;
      try {
        await this.write((database) => {
          const claimed = this.read(project, database);
          if (
            claimed?.token !== right.token ||
            claimed.state !== "claimed" ||
            !bound.isAlive() ||
            !this.leaseHeld(claimed)
          )
            throw new Error(`cannot verify dispatcher worker claim: ${name}`);
          this.put(database, { ...claimed, peer: bound.peer, state: "active" });
        });
        if (!bound.isAlive() || !this.leaseHeld(right))
          throw new Error(`Cannot confirm the activated Windows dispatcher worker: ${name}`);
      } finally {
        await bound.close();
      }
      return restarted;
    } catch (error) {
      await this.revokeUnused(right);
      throw error;
    }
  }

  async stop(socket: string, project: string | null): Promise<boolean> {
    const right = this.read(project);
    return right ? await this.retire(socket, right) : false;
  }

  async list(socket: string): Promise<WorkerEntry[]> {
    const entries = this.readAll().filter(
      (right) => right.state === "active" && this.leaseHeld(right),
    );
    const verified = await Promise.all(
      entries.map(async (right) => {
        const observed = await this.runtime.observe(socket, right);
        if (observed.state !== "bound") return;
        const bound = observed.connection;
        try {
          if (bound.isAlive() && this.leaseHeld(right))
            return { project: right.project, name: right.name, created: right.created };
        } finally {
          await bound.close();
        }
      }),
    );
    return verified.filter((entry) => entry !== undefined);
  }

  async runWorker(
    socket: string,
    project: string | null,
    token: string,
    run: () => Promise<void>,
  ): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("Missing Windows dispatcher worker launch right");
    const reserved = this.read(project);
    if (reserved?.token !== token || reserved.state !== "reserved") return;
    if ((await this.runtime.management(socket)) !== reserved.generation)
      throw new Error("Windows pi-mux management changed before dispatcher worker claim");
    const lease = new Database(leasePath(this.directory, token));
    try {
      lease.exec("BEGIN IMMEDIATE");
      const observed = await this.runtime.observe(socket, reserved);
      if (observed.state !== "bound")
        throw new Error("Cannot identify the claiming dispatcher peer");
      const bound = observed.connection;
      let claimed: boolean;
      try {
        claimed = await this.write((database) => {
          const right = this.read(project, database);
          if (right?.token !== token || right.state !== "reserved" || !bound.isAlive())
            return false;
          this.put(database, { ...right, peer: bound.peer, state: "claimed" });
          return true;
        });
      } finally {
        await bound.close();
      }
      if (!claimed) return;
      if (
        !(await poll(() => this.read(project)?.state === "active", this.runtime.activationTimeout))
      )
        return;
      const active = this.read(project);
      if (active?.token === token && active.state === "active") await run();
    } finally {
      lease.close();
    }
  }

  private async checkOverlaps(
    socket: string,
    project: string | null,
  ): Promise<WorkerRight | undefined> {
    for (const other of this.readAll()) {
      if (scope(other.project) === scope(project) || (project !== null && other.project !== null))
        continue;
      const current = await this.revokeUnused(other);
      if (this.workerRunning(current))
        throw new Error("overlapping dispatcher already running: " + current.name);
      const observed = await this.runtime.observe(socket, current);
      if (observed.state === "bound") {
        await observed.connection.close();
        throw new Error("overlapping dispatcher already running: " + current.name);
      }
      if (observed.state !== "gone")
        throw new Error("cannot verify overlapping dispatcher has stopped: " + current.name);
      await this.removeEnded(current);
    }
    return this.read(project);
  }

  private async retire(socket: string, right: WorkerRight): Promise<boolean> {
    const current = await this.revokeUnused(right);
    const wasRunning = this.workerRunning(current);
    const observed = await this.runtime.observe(socket, current);
    if (observed.state === "gone" && (!wasRunning || !this.workerRunning(current))) {
      await this.removeEnded(current);
      return false;
    }
    if (observed.state !== "bound")
      throw new Error("cannot verify dispatcher worker to stop: " + current.name);
    const bound = observed.connection;
    const pinned = { ...current, peer: bound.peer ?? current.peer };
    try {
      if (pinned.peer && !current.peer) await this.pinPeer(pinned);
      bound.stop();
      if (
        !(await poll(
          () => !bound.isAlive() && !this.workerRunning(current),
          this.runtime.stopTimeout,
        ))
      )
        throw new Error("cannot confirm dispatcher worker stopped: " + current.name);
    } finally {
      await bound.close();
    }
    await this.confirmSessionGone(socket, pinned);
    await this.removeEnded(pinned);
    return current.state !== "revoked";
  }

  private async confirmSessionGone(socket: string, right: WorkerRight): Promise<void> {
    const deadline = Date.now() + this.runtime.stopTimeout;
    do {
      const observed = await this.runtime.observe(socket, right);
      if (observed.state === "gone") return;
      if (observed.state === "bound") await observed.connection.close();
      await Bun.sleep(POLL_MS);
    } while (Date.now() < deadline);
    throw new Error("cannot confirm dispatcher worker session is gone: " + right.name);
  }

  private workerRunning(right: WorkerRight): boolean {
    return (right.state === "claimed" || right.state === "active") && this.leaseHeld(right);
  }

  private leaseHeld(right: WorkerRight): boolean {
    const path = leasePath(this.directory, right.token);
    if (!statSync(path).isFile()) throw new Error(`Invalid Windows dispatcher lease: ${path}`);
    const lease = new Database(path, { readwrite: true, create: false });
    try {
      lease.exec("BEGIN IMMEDIATE");
      return false;
    } catch (error) {
      if (isBusy(error)) return true;
      throw error;
    } finally {
      lease.close();
    }
  }

  private async revokeUnused(right: WorkerRight): Promise<WorkerRight> {
    return await this.write((database) => {
      const current = this.read(right.project, database);
      if (current?.token !== right.token) throw new Error("Windows dispatcher claim changed");
      if (current.state !== "reserved") return current;
      const revoked = { ...current, state: "revoked" } as const;
      this.put(database, revoked);
      return revoked;
    });
  }

  private async pinPeer(right: WorkerRight): Promise<void> {
    await this.write((database) => {
      const current = this.read(right.project, database);
      if (current?.token !== right.token) throw new Error("Windows dispatcher claim changed");
      this.put(database, { ...current, peer: right.peer });
    });
  }

  private async removeRight(right: WorkerRight): Promise<void> {
    await this.write((database) => {
      if (this.read(right.project, database)?.token !== right.token)
        throw new Error("Windows dispatcher claim changed before cleanup");
      this.remove(database, right.project);
    });
  }

  private async removeEnded(right: WorkerRight): Promise<void> {
    await this.removeRight(right);
    if (right.state !== "revoked") rmSync(leasePath(this.directory, right.token), { force: true });
  }

  private read(project: string | null, database?: Database): WorkerRight | undefined {
    return this.readAll(database).find((right) => scope(right.project) === scope(project));
  }

  private readAll(database?: Database): WorkerRight[] {
    const path = join(this.directory, "rights.sqlite");
    if (!database) {
      try {
        statSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const readonly = new Database(path, { readonly: true });
      try {
        readonly.exec("PRAGMA busy_timeout = 1000");
        return this.readAll(readonly);
      } finally {
        readonly.close();
      }
    }
    const rows = database
      .query<{ scope: string; record: string }, []>("SELECT scope, record FROM rights")
      .all();
    return rows.map((row) => {
      const right = JSON.parse(row.record) as WorkerRight;
      if (
        !right ||
        typeof right.token !== "string" ||
        !TOKEN.test(right.token) ||
        typeof right.generation !== "string" ||
        !GENERATION.test(right.generation) ||
        !(typeof right.project === "string" || right.project === null) ||
        row.scope !== scope(right.project) ||
        right.name !==
          `ticket_dispatch_${right.project === null ? "all" : Buffer.from(right.project).toString("hex")}` ||
        !Number.isSafeInteger(right.created) ||
        (right.peer !== undefined &&
          (typeof right.peer !== "string" || !PEER_IDENTITY.test(right.peer))) ||
        !["reserved", "revoked", "claimed", "active"].includes(right.state)
      )
        throw new Error("Invalid Windows dispatcher launch right");
      return right;
    });
  }

  private async write<T>(edit: (database: Database) => T): Promise<T> {
    mkdirSync(this.directory, { recursive: true });
    const database = new Database(join(this.directory, "rights.sqlite"));
    try {
      await runClaimTransaction(database, "BEGIN IMMEDIATE");
      database.exec(
        "CREATE TABLE IF NOT EXISTS rights (scope TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      const result = edit(database);
      await runClaimTransaction(database, "COMMIT");
      return result;
    } finally {
      database.close();
    }
  }

  private put(database: Database, right: WorkerRight): void {
    database.run("UPDATE rights SET record = ? WHERE scope = ?", [
      JSON.stringify(right),
      scope(right.project),
    ]);
  }

  private remove(database: Database, project: string | null): void {
    database.run("DELETE FROM rights WHERE scope = ?", [scope(project)]);
  }
}

export function windowsWorkerSocket(): string | undefined {
  return process.env[SOCKET_ENV];
}
