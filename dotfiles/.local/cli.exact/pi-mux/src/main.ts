import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Operation =
  | { kind: "new"; detached: boolean; request?: string }
  | { kind: "open"; id: string }
  | { kind: "close"; id: string }
  | { kind: "list" }
  | { kind: "workspace"; action: "register" | "unregister"; cwd: string }
  | { kind: "snapshot"; generation?: string }
  | { kind: "restore" };
type Candidate = { id: string; cwd: string };
type ManagedSession = Candidate & { session: string };
type RestoreState = { version: 1; generation: string; sessions: Candidate[] };
type Workspace = { cwd: string; sessions: string[] };
type Snapshot = { version: 1; generation: string; workspaces: Workspace[] };
type Session = { id: string; cwd: string; file: string };
type SessionState = "running" | "waiting-approval" | "waiting-user";
type Pane = Session & {
  pane: string;
  session: string;
  name: string;
  pid: number;
  panePid: number;
  startup?: "accepted" | "ready";
};
type StopTarget = Pick<Pane, "pane" | "pid" | "panePid">;
type MembershipStore = Record<string, unknown> & {
  "active-workspaces": Record<string, Record<string, unknown>>;
};
type ListedSession = {
  id: string;
  file: string;
  state: SessionState | null;
  title: string | null;
};
type ListedWorkspace = { cwd: string; sessions: ListedSession[] };
type Config = ReturnType<typeof configuration>;
type TmuxConfig = ReturnType<typeof tmuxConfiguration>;

const EMPTY_SESSION = "pi-empty";
const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const GENERATED_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "TERM",
  "SHELL",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
]);
const PARENT_ENV_KEYS = new Set([
  "TMUX",
  "TMUX_PANE",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_AGENT_NAME",
  "PI_AGENT_CONFIG",
  "PI_TMUX_SESSION_ID",
  "PI_TMUX_STARTUP_COMMAND",
  "PI_TMUX_STARTUP_MODE",
]);
const PANE_FORMAT =
  "#{pane_id}\t#{session_id}\t#{session_name}\t#{@pi-tmux-session}\t#{pane_pid}\t#{pane_dead}";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const operation = parseOperation(argv);
    if (operation.kind === "list") {
      console.log(JSON.stringify(await listWorkspaces(tmuxConfiguration())));
      return 0;
    }
    if (operation.kind === "close") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      return await withLock(config, async () => {
        await closeSession(config, operation.id);
        return 0;
      });
    }
    if (operation.kind === "workspace") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      return await withLock(config, async () => {
        if (operation.action === "register") {
          if (!statSync(operation.cwd).isDirectory())
            throw new Error(`Workspace is not a directory: ${operation.cwd}`);
          registerWorkspaces(config, [operation.cwd]);
        } else await unregisterWorkspace(config, operation.cwd);
        return 0;
      });
    }
    const config = configuration();
    prepareDirectory(config.stateDirectory);
    const result = await withLock(config, async () => {
      if (operation.kind === "snapshot") {
        await snapshotSessions(config, operation.generation);
        return 0;
      }
      prepareDirectory(config.directory);
      const configured = await configuredSessionRoots(config);
      if (configured.preferred) rememberSessionRoot(config, configured.preferred);
      const failures = await startAndRestore(config, operation.kind === "restore");
      if (operation.kind === "restore") return failures > 0 ? 2 : 0;
      const target =
        operation.kind === "open"
          ? await openSaved(config, operation.id)
          : operation.request === undefined
            ? await openNew(config)
            : await createIndependent(config, operation.request);
      registerWorkspaces(config, [target.cwd]);
      rememberSessionRoot(config, dirname(target.file));
      if (operation.kind === "new" && operation.detached) {
        const attach = shellCommand([
          config.tmux,
          "-S",
          config.socket,
          "attach-session",
          "-t",
          target.session,
        ]);
        console.log(`Pi session ${target.id}\nAttach with: ${attach}`);
        return 0;
      }
      return target;
    });
    if (typeof result === "number") return result;
    const client = Bun.spawn(
      [config.tmux, "-S", config.socket, "attach-session", "-t", result.session],
      { env: config.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return await client.exited;
  } catch (error) {
    console.error(`pi-mux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function parseOperation(argv: string[]): Operation {
  if (argv.length === 0) return { kind: "new", detached: false };
  if (argv[0] === "new") {
    const detached = argv[1] === "--detached";
    const requests = argv.slice(detached ? 2 : 1);
    const request = requests[0];
    if (requests.length === 0) return { kind: "new", detached };
    if (requests.length === 1 && request?.trim() && !request.includes("\0"))
      return { kind: "new", detached, request };
  }
  if (
    argv.length === 2 &&
    (argv[0] === "open" || argv[0] === "close") &&
    SESSION_ID_PATTERN.test(argv[1]!)
  )
    return { kind: argv[0], id: argv[1]! };
  if (
    argv.length === 3 &&
    argv[0] === "workspace" &&
    (argv[1] === "register" || argv[1] === "unregister") &&
    argv[2]?.trim() &&
    !argv[2].includes("\0")
  )
    return { kind: "workspace", action: argv[1], cwd: resolve(argv[2]) };
  if (argv.length === 1 && argv[0] === "list") return { kind: "list" };
  if (argv.length === 1 && argv[0] === "restore") return { kind: "restore" };
  if ((argv.length === 1 || argv.length === 2) && argv[0] === "snapshot")
    return { kind: "snapshot", generation: argv[1] };
  throw new Error(
    "usage: pi-mux [new [--detached] [initial-request] | open <session-id> | close <session-id> | list | workspace register|unregister <cwd> | snapshot [server-generation] | restore]",
  );
}

function configuration() {
  const config = tmuxConfiguration();
  if (!existsSync(config.extension) || !existsSync(config.tmuxConfig))
    throw new Error(
      `Missing pi-mux extension or tmux configuration: ${config.extension}, ${config.tmuxConfig}`,
    );
  return { ...config, pi: executable("pi") };
}

function tmuxConfiguration() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const agentDir = expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
  const directory = join(runtime, "pi-tmux");
  const extension = join(agentDir, "extensions", "pi-mux-bridge", "index.ts");
  const tmuxConfig = join(homedir(), ".config", "tmux", "pi.conf");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PARENT_ENV_KEYS.has(entry[0]),
    ),
  );
  return {
    agentDir,
    stateDirectory: join(agentDir, "pi-tmux"),
    directory,
    extension,
    tmuxConfig,
    env,
    socket: join(directory, "server.sock"),
    tmux: executable("tmux"),
  };
}

async function withLock<T>(config: TmuxConfig, action: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(realpathSync(config.stateDirectory)).digest("hex");
  const address = `\0pi-mux-${process.getuid!()}-${key}`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lock = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        lock.once("error", reject);
        lock.listen(address, resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      await new Promise<void>((resolve, reject) => {
        lock.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  throw new Error("Timed out waiting for another pi-mux operation");
}

async function startAndRestore(config: Config, restoreRequested: boolean): Promise<number> {
  await tmux(config, ["start-server"]);
  await tmux(config, ["source-file", config.tmuxConfig]);
  const existing = await serverOption(config, "@pi-mux-generation");
  const generation = existing || randomUUID();
  if (!existing) await tmux(config, ["set-option", "-g", "@pi-mux-generation", generation]);
  const invocation = import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, fileURLToPath(import.meta.url)];
  const hookCommand = shellCommand([
    "/usr/bin/env",
    `HOME=${config.env.HOME || homedir()}`,
    `PATH=${config.env.PATH || ""}`,
    `XDG_RUNTIME_DIR=${dirname(config.directory)}`,
    `PI_CODING_AGENT_DIR=${config.agentDir}`,
    ...invocation,
    "snapshot",
  ]);
  await tmux(config, ["set-option", "-g", "@pi-mux-snapshot", hookCommand]);
  const restored = await serverOption(config, "@pi-mux-restored");
  if (!restoreRequested && restored === generation) return 0;
  let failures = 0;
  try {
    failures = await restoreSessions(config, generation);
  } catch (error) {
    console.error(`pi-mux: restore failed: ${errorMessage(error)}`);
    failures++;
  }
  await tmux(config, ["set-option", "-g", "@pi-mux-restored", generation]);
  return failures;
}

async function restoreSessions(config: Config, generation: string): Promise<number> {
  const previous = readSnapshot(config);
  const candidates = uniqueCandidates(previous?.sessions ?? []);
  let state: RestoreState = { version: 1, generation, sessions: candidates };
  await setRestoringSessions(config, candidates);
  writeSnapshot(config, state);
  let failures = 0;
  for (const candidate of candidates) {
    try {
      const saved = await findSaved(config, candidate.id, [], "restore");
      if (!saved) {
        console.error(`pi-mux: restore ${candidate.id}: saved conversation not found; removed`);
      } else {
        if (saved.cwd !== candidate.cwd)
          throw new Error(`Saved working directory differs from snapshot: ${saved.cwd}`);
        const restored = await openSaved(config, candidate.id);
        if (restored.startup !== "ready")
          throw new Error("Running pi has not confirmed initialization completion");
      }
      if (!saved)
        state = { ...state, sessions: state.sessions.filter((entry) => entry.id !== candidate.id) };
      writeSnapshot(config, state);
      await tmux(config, ["set-option", "-gu", `@pi-mux-restoring-${candidate.id}`]);
    } catch (error) {
      failures++;
      console.error(`pi-mux: restore ${candidate.id}: ${errorMessage(error)}`);
    }
  }
  await snapshotSessions(config, generation);
  return failures;
}

async function snapshotSessions(config: Config, expectedGeneration?: string): Promise<void> {
  const generation = await serverOption(config, "@pi-mux-generation");
  if (!generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  if (expectedGeneration !== undefined && generation !== expectedGeneration) return;
  const previous = readSnapshot(config);
  if (!previous || previous.generation !== generation) return;
  const managed = await managedSessions(config);
  const restoring = await Promise.all(
    previous.sessions.map(async (candidate) => {
      const marker = await serverOption(config, `@pi-mux-restoring-${candidate.id}`);
      if (marker && marker !== "1") throw new Error("Invalid in-memory restore state");
      return marker ? [candidate] : [];
    }),
  );
  const sessions = uniqueCandidates([
    ...restoring.flat(),
    ...managed.map(({ id, cwd }) => ({ id, cwd })),
  ]);
  if ((await serverOption(config, "@pi-mux-generation")) !== generation)
    throw new Error("Dedicated server changed during snapshot");
  writeSnapshot(config, { version: 1, generation, sessions });
}

async function setRestoringSessions(config: Config, candidates: Candidate[]): Promise<void> {
  for (const { id } of candidates)
    await tmux(config, ["set-option", "-g", `@pi-mux-restoring-${id}`, "1"]);
}

async function managedSessions(config: TmuxConfig): Promise<ManagedSession[]> {
  const listed = await tmux(config, ["list-sessions", "-F", "#{session_id}"], true);
  if (listed.exitCode !== 0) {
    if (serverIsAbsent(config, listed.stderr) || listed.stderr.includes("no sessions")) return [];
    throw new Error(`Cannot inspect managed sessions: ${listed.stderr.trim()}`);
  }
  const sessions: ManagedSession[] = [];
  for (const session of listed.stdout.trim().split("\n").filter(Boolean)) {
    const environment = await tmux(
      config,
      ["show-environment", "-t", session, "PI_TMUX_SESSION_ID"],
      true,
    );
    if (environment.exitCode !== 0) {
      if (environment.stderr.includes("unknown variable: PI_TMUX_SESSION_ID")) continue;
      throw new Error(`Cannot inspect tmux session ${session}: ${environment.stderr.trim()}`);
    }
    const id = environment.stdout.replace(/\n$/, "").slice("PI_TMUX_SESSION_ID=".length);
    if (!SESSION_ID_PATTERN.test(id))
      throw new Error(`Invalid conversation ID in tmux session ${session}`);
    const path = await tmux(config, ["display-message", "-p", "-t", session, "#{session_path}"]);
    const cwd = path.stdout.replace(/\n$/, "");
    if (!isAbsolute(cwd)) throw new Error(`Invalid working directory in tmux session ${session}`);
    sessions.push({ id, cwd, session });
  }
  return sessions;
}

async function serverOption(config: TmuxConfig, option: string): Promise<string> {
  return (await tmux(config, ["show-options", "-gqv", option])).stdout.trim();
}

function uniqueCandidates(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = byId.get(candidate.id);
    if (previous && previous.cwd !== candidate.cwd)
      throw new Error(`Conflicting working directories for conversation ${candidate.id}`);
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function snapshotPath(config: TmuxConfig): string {
  return join(config.stateDirectory, "pi-mux-restore.json");
}

function readSnapshot(config: TmuxConfig): RestoreState | undefined {
  const path = snapshotPath(config);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read snapshot ${path}: ${errorMessage(error)}`);
  }
  const state = raw as Partial<Snapshot> | null;
  if (
    !state ||
    state.version !== 1 ||
    typeof state.generation !== "string" ||
    !Array.isArray(state.workspaces)
  )
    throw new Error(`Invalid snapshot: ${path}`);
  for (const workspace of state.workspaces) {
    if (
      !workspace ||
      typeof workspace.cwd !== "string" ||
      !isAbsolute(workspace.cwd) ||
      !Array.isArray(workspace.sessions)
    )
      throw new Error(`Invalid snapshot workspace: ${path}`);
    for (const id of workspace.sessions) {
      if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
        throw new Error(`Invalid snapshot candidate: ${path}`);
    }
  }
  const sessions = state.workspaces.flatMap((workspace) =>
    workspace.sessions.map((id) => ({ id, cwd: workspace.cwd })),
  );
  uniqueCandidates(sessions);
  return { version: 1, generation: state.generation, sessions };
}

function writeSnapshot(config: TmuxConfig, state: RestoreState): void {
  const workspaces = new Map<string, Workspace>();
  for (const { id, cwd } of state.sessions) {
    let workspace = workspaces.get(cwd);
    if (!workspace) {
      workspace = { cwd, sessions: [] };
      workspaces.set(cwd, workspace);
    }
    workspace.sessions.push(id);
  }
  const snapshot: Snapshot = {
    version: state.version,
    generation: state.generation,
    workspaces: [...workspaces.values()],
  };
  const temporary = join(config.stateDirectory, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(snapshot) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, snapshotPath(config));
  const directory = openSync(config.stateDirectory, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

async function createIndependent(config: Config, request: string): Promise<Pane> {
  const id = randomUUID();
  const name = sessionName(id);
  const created = await createSession(
    config,
    {
      id,
      cwd: process.cwd(),
      request,
    },
    name,
  );
  return await waitForSession(config, created ?? name, id, "accepted");
}

function shellCommand(args: string[]): string {
  return args.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openNew(config: Config): Promise<Pane> {
  const cwd = process.cwd();
  const name = `${EMPTY_SESSION}-${createHash("sha256").update(cwd).digest("hex")}`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const panes = await livePanes(config);
    const empty = panes.filter(
      (pane) =>
        (pane.name === name || pane.name === EMPTY_SESSION) &&
        pane.cwd === cwd &&
        !existsSync(pane.file),
    );
    if (empty.length > 1) throw new Error("Multiple unsaved new sessions are running");
    if (empty[0]) return empty[0];

    const reserved = await hasSession(config, name);
    if (reserved) {
      const previous = (await livePanes(config)).find((pane) => pane.name === name);
      if (!previous) {
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (previous.cwd === cwd && !existsSync(previous.file)) return previous;
      const renamed = await tmux(
        config,
        ["rename-session", "-t", previous.session, sessionName(previous.id)],
        true,
      );
      if (renamed.exitCode !== 0) continue;
    }
    const id = randomUUID();
    const created = await createSession(config, { id, cwd }, name);
    if (created) return await waitForSession(config, created, id);
  }
  throw new Error("Timed out reserving an unsaved new session");
}

async function openSaved(config: Config, id: string): Promise<Pane> {
  const managed = (await managedSessions(config)).filter((session) => session.id === id);
  if (managed.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const running = (await livePanes(config)).filter((pane) => pane.id === id);
  if (running.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const saved = await findSaved(
    config,
    id,
    running.map((pane) => dirname(pane.file)),
  );
  if (running[0]) return running[0];
  if (managed[0]) return await waitForSession(config, managed[0].session, id);
  if (!saved) throw new Error(`Session not found (use the complete ID): ${id}`);
  if (!existsSync(saved.cwd) || !statSync(saved.cwd).isDirectory())
    throw new Error(`Session working directory does not exist: ${saved.cwd}`);
  const name = sessionName(id);
  const created = await createSession(config, saved, name);
  return await waitForSession(config, created ?? name, id);
}

async function createSession(
  config: Config,
  session: { id: string; cwd: string; file?: string; request?: string },
  name: string,
): Promise<string | undefined> {
  const startupCommand =
    session.request === undefined ? `pi-mux-startup-${randomUUID()}` : undefined;
  const desired = {
    ...config.env,
    PI_TMUX_SESSION_ID: session.id,
    ...(startupCommand === undefined
      ? { PI_TMUX_STARTUP_MODE: "create" }
      : { PI_TMUX_STARTUP_COMMAND: startupCommand }),
  };
  const global = await tmux(config, ["show-environment", "-gs"]);
  const assignments = global.stdout.replace(/"(?:\\.|[^"\\])*"/gs, "");
  const removed = [...assignments.matchAll(/; export ([^;\n]+);/g)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(desired, key) && !GENERATED_ENV_KEYS.has(key));
  const environment = Object.entries(desired).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const selection = session.file ? ["--session", session.file] : ["--session-id", session.id];
  const command = [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}\t#{pane_id}\t#{pane_pid}",
    "-s",
    name,
    "-n",
    "pi",
    "-c",
    session.cwd,
    "-x",
    String(process.stdout.columns || 80),
    "-y",
    String(process.stdout.rows || 24),
    ...environment,
    "--",
    "/usr/bin/env",
    ...removed.flatMap((key) => ["-u", key]),
    config.pi,
    ...selection,
    "-e",
    config.extension,
    ...(session.request === undefined
      ? ["--", `/${startupCommand}`]
      : ["--agent", "main", "--", session.request]),
  ]
    .map(quoteTmuxArgument)
    .join(" ");
  const result = await tmux(config, ["source-file", "-"], true, `${command}\n`);
  if (result.exitCode === 0) {
    const [target, pane, pid] = result.stdout.trim().split("\t");
    if (
      !target ||
      !/^\$[0-9]+$/.test(target) ||
      !pane ||
      !/^%[0-9]+$/.test(pane) ||
      !pid ||
      !/^[1-9]\d*$/.test(pid)
    )
      throw new Error("Cannot identify the created tmux session and pane");
    const started = processStartTime(Number(pid));
    if (started === undefined)
      throw new Error(`pi exited before launch was recorded: ${session.id}`);
    await tmux(config, [
      "set-option",
      "-p",
      "-t",
      pane,
      "@pi-mux-launch",
      JSON.stringify({ id: session.id, pid: Number(pid), started }),
    ]);
    return target;
  }
  if (await hasSession(config, name)) return undefined;
  throw new Error(`Cannot start pi session: ${result.stderr.trim()}`);
}

async function waitForSession(
  config: Config,
  target: string,
  expectedId: string,
  startup: "accepted" | "ready" = "ready",
): Promise<Pane> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  function matches(candidate: Pane): boolean {
    return candidate.id === expectedId && (startup === "accepted" || candidate.startup === "ready");
  }
  while (Date.now() < deadline) {
    const pane = (await livePanes(config)).find(matches);
    if (pane) return pane;
    if (!(await hasSession(config, target))) {
      const moved = (await livePanes(config)).find(matches);
      if (moved) return moved;
      throw new Error(`pi exited before startup: ${expectedId}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`pi startup timed out: ${expectedId}`);
}

async function listWorkspaces(config: TmuxConfig): Promise<ListedWorkspace[]> {
  const panes = await livePanes(config, "list");
  const current = readMembershipStore(config);
  if (panes.some(({ cwd }) => !Object.hasOwn(current["active-workspaces"], cwd))) {
    prepareDirectory(config.stateDirectory);
    return await withLock(config, async () =>
      collectWorkspaceList(config, await livePanes(config, "list"), "import"),
    );
  }
  return await collectWorkspaceList(config, panes);
}

async function collectWorkspaceList(
  config: TmuxConfig,
  panes: Pane[],
  membership: "read" | "import" = "read",
): Promise<ListedWorkspace[]> {
  const sessions = await Promise.all(
    panes.map(async ({ id, cwd, file, pane }) => {
      const metadata = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        pane,
        "@pi_session_state",
      ]);
      return { cwd, session: { id, file, ...parseSessionMetadata(metadata.stdout, id) } };
    }),
  );
  if (membership === "import")
    registerWorkspaces(
      config,
      panes.map(({ cwd }) => cwd),
    );
  const workspaces = new Map<string, ListedWorkspace>(
    Object.keys(readMembershipStore(config)["active-workspaces"]).map((cwd) => [
      cwd,
      { cwd, sessions: [] },
    ]),
  );
  for (const { cwd, session } of sessions) workspaces.get(cwd)?.sessions.push(session);
  return [...workspaces.values()];
}

function readMembershipStore(config: TmuxConfig): MembershipStore {
  const path = join(config.agentDir, "session-state.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { "active-workspaces": {} };
    throw new Error(`Cannot read workspace store ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || isRecord(value.workspaces) || !isRecord(value["active-workspaces"]))
    throw new Error(`Invalid workspace store: ${path}`);
  for (const [cwd, workspace] of Object.entries(value["active-workspaces"])) {
    if (
      !isAbsolute(cwd) ||
      !isRecord(workspace) ||
      (workspace["active-sessions"] !== undefined && !isRecord(workspace["active-sessions"]))
    )
      throw new Error(`Invalid workspace entry in ${path}: ${cwd}`);
  }
  return value as MembershipStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeMembershipStore(config: TmuxConfig, store: MembershipStore): void {
  const path = join(config.agentDir, "session-state.json");
  const temporary = join(config.agentDir, `session-state.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function registerWorkspaces(config: TmuxConfig, cwds: string[]): void {
  const store = readMembershipStore(config);
  let changed = false;
  for (const cwd of cwds) {
    if (Object.hasOwn(store["active-workspaces"], cwd)) continue;
    store["active-workspaces"][cwd] = { "active-sessions": {} };
    changed = true;
  }
  if (changed) writeMembershipStore(config, store);
}

async function closeSession(config: TmuxConfig, id: string): Promise<void> {
  try {
    readSnapshot(config);
    const panes = await livePanes(config, "list");
    const running = panes.filter((pane) => pane.id === id);
    const managed = (await managedSessions(config)).filter((session) => session.id === id);
    if (running.length > 1 || managed.length > 1)
      throw new Error("Multiple pi processes match the conversation ID");
    const targets = [...running, ...(await initializingPanes(config, managed, panes))];
    if (targets.length > 1) throw new Error("Multiple pi processes match the conversation ID");
    await terminatePanes(config, targets);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      const current = await livePanes(config, "list");
      if (
        !current.some((pane) => pane.id === id) &&
        !targets.some((pane) => processIsAlive(pane.pid))
      )
        break;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for pi to exit");
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    for (const session of managed) {
      const result = await tmux(
        config,
        ["set-environment", "-u", "-t", session.session, "PI_TMUX_SESSION_ID"],
        true,
      );
      if (
        result.exitCode !== 0 &&
        !serverIsAbsent(config, result.stderr) &&
        !result.stderr.includes("can't find session:")
      )
        throw new Error(`Cannot clear managed session ${session.session}: ${result.stderr.trim()}`);
    }
    const cleared = await tmux(config, ["set-option", "-gu", `@pi-mux-restoring-${id}`], true);
    if (cleared.exitCode !== 0 && !serverIsAbsent(config, cleared.stderr))
      throw new Error(`Cannot clear restore target: ${cleared.stderr.trim()}`);
    const snapshot = readSnapshot(config);
    if (snapshot?.sessions.some((session) => session.id === id))
      writeSnapshot(config, {
        ...snapshot,
        sessions: snapshot.sessions.filter((session) => session.id !== id),
      });
  } catch (error) {
    throw new Error(`Cannot close session ${id}: ${errorMessage(error)}`);
  }
}

async function terminatePanes(config: TmuxConfig, targets: StopTarget[]): Promise<void> {
  for (const pane of targets) {
    if (pane.pid !== pane.panePid) {
      try {
        process.kill(pane.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else {
      const result = await tmux(
        config,
        [
          "if-shell",
          "-F",
          "-t",
          pane.pane,
          `#{==:#{pane_pid},${pane.panePid}}`,
          shellCommand(["kill-pane", "-t", pane.pane]),
        ],
        true,
      );
      if (result.exitCode !== 0 && processIsAlive(pane.pid))
        throw new Error(`Cannot stop pi in pane ${pane.pane}: ${result.stderr.trim()}`);
    }
  }
}

async function unregisterWorkspace(config: TmuxConfig, cwd: string): Promise<void> {
  readMembershipStore(config);
  readSnapshot(config);
  const panes = await livePanes(config, "list");
  const targets = [
    ...panes.filter((pane) => pane.cwd === cwd),
    ...(await initializingPanes(
      config,
      (await managedSessions(config)).filter((session) => session.cwd === cwd),
      panes,
    )),
  ];
  await terminatePanes(config, targets);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (true) {
    const current = await livePanes(config, "list");
    const remaining = current.some((pane) => pane.cwd === cwd);
    const initializing = await initializingPanes(
      config,
      (await managedSessions(config)).filter((session) => session.cwd === cwd),
      current,
    );
    if (
      !remaining &&
      initializing.length === 0 &&
      !targets.some((pane) => processIsAlive(pane.pid))
    )
      break;
    if (Date.now() >= deadline) throw new Error(`Timed out stopping workspace: ${cwd}`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  const snapshot = readSnapshot(config);
  if (snapshot) {
    for (const candidate of snapshot.sessions.filter((session) => session.cwd === cwd)) {
      const result = await tmux(
        config,
        ["set-option", "-gu", `@pi-mux-restoring-${candidate.id}`],
        true,
      );
      if (result.exitCode !== 0 && !serverIsAbsent(config, result.stderr))
        throw new Error(`Cannot clear restore target ${candidate.id}: ${result.stderr.trim()}`);
    }
    writeSnapshot(config, {
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.cwd !== cwd),
    });
  }
  const store = readMembershipStore(config);
  if (Object.hasOwn(store["active-workspaces"], cwd)) {
    delete store["active-workspaces"][cwd];
    writeMembershipStore(config, store);
  }
}

async function initializingPanes(
  config: TmuxConfig,
  managed: ManagedSession[],
  published: Pane[],
): Promise<StopTarget[]> {
  const targets: StopTarget[] = [];
  for (const session of managed) {
    const result = await tmux(config, [
      "list-panes",
      "-s",
      "-t",
      session.session,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_dead}",
    ]);
    const unpublished = result.stdout
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        const [pane, pid, dead] = line.split("\t");
        if (dead !== "0" || published.some((entry) => entry.pane === pane)) return [];
        if (!pane || !pid || !/^[1-9]\d*$/.test(pid))
          throw new Error(`Cannot identify initializing pi in ${session.session}`);
        return [{ pane, pid: Number(pid), panePid: Number(pid) }];
      });
    const matching: StopTarget[] = [];
    for (const target of unpublished) {
      const environment = readFileSync(`/proc/${target.pid}/environ`, "utf8").split("\0");
      if (
        !environment.includes(`PI_TMUX_SESSION_ID=${session.id}`) ||
        realpathSync(`/proc/${target.pid}/cwd`) !== realpathSync(session.cwd)
      )
        continue;
      const option = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        target.pane,
        "@pi-mux-launch",
      ]);
      let launch: unknown;
      try {
        launch = JSON.parse(option.stdout);
      } catch {
        throw new Error(`Cannot safely identify initializing pi ${session.id} in ${target.pane}`);
      }
      if (
        !isRecord(launch) ||
        launch.id !== session.id ||
        launch.pid !== target.pid ||
        typeof launch.started !== "string" ||
        launch.started !== processStartTime(target.pid)
      )
        throw new Error(`Cannot safely identify initializing pi ${session.id} in ${target.pane}`);
      matching.push(target);
    }
    if (
      unpublished.length > 0 &&
      matching.length === 0 &&
      !published.some((pane) => pane.session === session.session && pane.id === session.id)
    )
      throw new Error(`Cannot safely identify initializing pi ${session.id} in ${session.session}`);
    targets.push(...matching);
  }
  return targets;
}

function processStartTime(pid: number): string | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!started || !/^\d+$/.test(started))
    throw new Error(`Cannot identify process start time: ${pid}`);
  return started;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processDescendsFrom(pid: number, ancestor: number): boolean {
  let current = pid;
  while (current > 0) {
    if (current === ancestor) return true;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${current}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return false;
}

function serverIsAbsent(config: TmuxConfig, stderr: string): boolean {
  return (
    stderr.includes(`no server running on ${config.socket}`) ||
    stderr.includes(`error connecting to ${config.socket} (No such file or directory)`)
  );
}

async function livePanes(
  config: TmuxConfig,
  purpose: "startup" | "list" = "startup",
): Promise<Pane[]> {
  const result = await tmux(config, ["list-panes", "-a", "-F", PANE_FORMAT], true);
  if (result.exitCode !== 0) {
    if (result.stderr.includes("no sessions") || result.stderr.includes("no current target"))
      return [];
    if (purpose === "list" && serverIsAbsent(config, result.stderr)) return [];
    throw new Error(`Cannot inspect pi sessions: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const [pane, session, name, encoded, pid, dead] = line.split("\t");
      if (!pane || !session || !name || !encoded || dead !== "0") return [];
      const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (
        typeof metadata?.id !== "string" ||
        !SESSION_ID_PATTERN.test(metadata.id) ||
        typeof metadata.cwd !== "string" ||
        typeof metadata.file !== "string" ||
        !isAbsolute(metadata.cwd) ||
        !isAbsolute(metadata.file) ||
        !pid ||
        !/^[1-9]\d*$/.test(pid) ||
        metadata.pid !== Number(pid) ||
        (metadata.startup !== "accepted" &&
          metadata.startup !== "ready" &&
          !(purpose === "list" && metadata.startup === undefined))
      )
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      if (metadata.processPid !== undefined) {
        if (!Number.isSafeInteger(metadata.processPid) || metadata.processPid <= 0)
          throw new Error(`Invalid pi session metadata in pane ${pane}`);
        if (!processDescendsFrom(metadata.processPid, Number(pid))) return [];
      }
      return [
        {
          pane,
          session,
          name,
          pid: metadata.processPid ?? Number(pid),
          panePid: Number(pid),
          id: metadata.id,
          cwd: metadata.cwd,
          file: metadata.file,
          startup: metadata.startup,
        },
      ];
    });
}

function parseSessionMetadata(
  encoded: string | undefined,
  id: string,
): { state: SessionState | null; title: string | null } {
  const unavailable = { state: null, title: null };
  if (!encoded) return unavailable;
  let metadata: { version?: unknown; sessionId?: unknown; state?: unknown; title?: unknown } | null;
  try {
    metadata = JSON.parse(encoded);
  } catch {
    return unavailable;
  }
  if (metadata?.version !== 1 || metadata.sessionId !== id) return unavailable;
  const state = metadata.state;
  return {
    state:
      state === "running" || state === "waiting-approval" || state === "waiting-user"
        ? state
        : null,
    title: typeof metadata.title === "string" ? metadata.title : null,
  };
}

async function hasSession(config: Config, name: string): Promise<boolean> {
  const target = name.startsWith("$") ? name : `=${name}`;
  return (await tmux(config, ["has-session", "-t", target], true)).exitCode === 0;
}

function sessionName(id: string): string {
  return `pi-${createHash("sha256").update(id).digest("hex")}`;
}

async function configuredSessionRoots(config: Config) {
  const settingPaths = [
    join(config.agentDir, "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];
  const settings = await Promise.all(
    settingPaths.map(async (path) => {
      if (!existsSync(path)) return undefined;
      const parsed = Bun.JSONC.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`Invalid settings in ${path}`);
      const sessionDir = "sessionDir" in parsed ? parsed.sessionDir : undefined;
      if (sessionDir === undefined) return undefined;
      if (typeof sessionDir !== "string") throw new Error(`Invalid sessionDir in ${path}`);
      return expandPath(sessionDir);
    }),
  );
  const override = config.env.PI_CODING_AGENT_SESSION_DIR;
  const preferred = override ? expandPath(override) : settings[1] || settings[0];
  return {
    preferred,
    roots: [
      join(config.agentDir, "sessions"),
      ...settings.filter((path): path is string => Boolean(path)),
      ...(override ? [expandPath(override)] : []),
    ],
  };
}

function registryDirectory(config: Config): string {
  return join(config.agentDir, "pi-tmux", "session-dirs");
}

function rememberSessionRoot(config: Config, root: string): void {
  prepareDirectory(dirname(registryDirectory(config)));
  const directory = registryDirectory(config);
  prepareDirectory(directory);
  const key = createHash("sha256").update(root).digest("hex");
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(root) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, `${key}.json`));
}

async function rememberedSessionRoots(config: Config): Promise<string[]> {
  const directory = registryDirectory(config);
  if (!existsSync(directory)) return [];
  prepareDirectory(directory);
  const entries = await readdir(directory);
  return await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(directory, name);
        const root = JSON.parse(await readFile(path, "utf8"));
        if (typeof root !== "string" || !isAbsolute(root))
          throw new Error(`Invalid recorded session directory: ${path}`);
        return root;
      }),
  );
}

async function findSaved(
  config: Config,
  id: string,
  liveRoots: string[],
  purpose: "open" | "restore" = "open",
): Promise<Session | undefined> {
  const configured = await configuredSessionRoots(config);
  const roots = [
    ...new Set([...configured.roots, ...(await rememberedSessionRoots(config)), ...liveRoots]),
  ];
  const files = [
    ...new Set(
      (await Promise.all(roots.map(sessionFiles))).flat().map((file) => realpathSync(file)),
    ),
  ];
  const matches = files.flatMap((file) => {
    const header = readHeader(file);
    if (
      header?.type !== "session" ||
      typeof header.id !== "string" ||
      !SESSION_ID_PATTERN.test(header.id) ||
      typeof header.cwd !== "string" ||
      !isAbsolute(header.cwd)
    ) {
      if (purpose === "restore" || header?.id === id)
        throw new Error(`Invalid session header: ${file}`);
      return [];
    }
    if (header.id !== id) return [];
    return [{ id, file, cwd: header.cwd }];
  });
  if (matches.length > 1) throw new Error(`Ambiguous session ID: ${id} (${matches.length} files)`);
  return matches[0];
}

async function sessionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await sessionFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return files.flat();
}

function readHeader(path: string): { type?: unknown; id?: unknown; cwd?: unknown } | undefined {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString("utf8").split("\n")[0]!;
    try {
      const header = JSON.parse(firstLine);
      return header && typeof header === "object" && !Array.isArray(header) ? header : undefined;
    } catch {
      return undefined;
    }
  } finally {
    closeSync(fd);
  }
}

function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    throw new Error(`Unsafe runtime directory: ${path}`);
}

function expandPath(path: string): string {
  if (path.startsWith("file://")) return fileURLToPath(path);
  return resolve(
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
  );
}

function executable(name: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Executable not found on PATH: ${name}`);
  return path;
}

function quoteTmuxArgument(argument: string): string {
  return JSON.stringify(argument).replaceAll("$", "\\$");
}

async function tmux(config: TmuxConfig, args: string[], allowFailure = false, input?: string) {
  const child = Bun.spawn([config.tmux, "-S", config.socket, "-f", config.tmuxConfig, ...args], {
    env: config.env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(`tmux ${args[0]} failed: ${stderr.trim()}`);
  return { stdout, stderr, exitCode };
}

if (import.meta.main) process.exitCode = await main();
