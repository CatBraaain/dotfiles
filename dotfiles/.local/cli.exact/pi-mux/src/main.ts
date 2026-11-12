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
import { HistorySummaryCache, parseEpochMs } from "./history-summary";

type Operation =
  | { kind: "help" }
  | { kind: "new"; detached: boolean; request?: string }
  | { kind: "open"; id: string; temporary: boolean }
  | { kind: "state"; id: string; source: StateSource; notification: StateNotification }
  | { kind: "close"; id: string; ifTemporary: boolean }
  | { kind: "list" }
  | { kind: "switch"; id: string; clientPid: number | undefined }
  | { kind: "current"; clientPid: number | undefined }
  | { kind: "history"; cwd: string | undefined }
  | { kind: "workspace"; action: "register" | "unregister"; cwd: string }
  | { kind: "snapshot"; generation?: string }
  | { kind: "restore" };
type Candidate = { id: string; cwd: string };
type ManagedSession = Candidate & { session: string; temporary: boolean };
type StateSource = {
  socket: string;
  serverPid: number;
  serverStartTime: string;
  pane: string;
  pid: number;
  started: string;
};
type StateNotification =
  | { clear: true }
  | { clear: false; state: SessionState; title: string | null };
type RestoreState = { version: 1; generation: string; sessions: Candidate[] };
type Workspace = { cwd: string; sessions: string[] };
type Snapshot = { version: 1; generation: string; workspaces: Workspace[] };
type Session = { id: string; cwd: string; file: string };
type SessionState = "running" | "waiting-approval" | "waiting-user";
type Pane = Session & {
  pane: string;
  session: string;
  name: string;
  active: boolean;
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
  temporary?: true;
};
type EmptySession = { id: string; file: string; temporary?: true };
type ListedWorkspace = { cwd: string; sessions: ListedSession[]; empty: EmptySession[] };
type TmuxClient = { name: string; pid: number; session: string };
type CurrentSession = { id: string; cwd: string; file: string; target: string };
type HistoryEntry = {
  id: string;
  cwd: string;
  file: string;
  title: string | null;
  btime: number;
  mtime: number | null;
  size: number;
};
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
  "PI_TMUX_TEMPORARY",
  "PI_TMUX_STARTUP_COMMAND",
  "PI_TMUX_STARTUP_MODE",
]);
const PANE_FORMAT =
  "#{pane_id}\t#{session_id}\t#{session_name}\t#{@pi-tmux-session}\t#{pane_pid}\t#{pane_dead}\t#{window_active}\t#{pane_active}";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const operation = parseOperation(argv);
    if (operation.kind === "help") {
      console.log(`Usage:
  pi-mux
  pi-mux -h
  pi-mux --help
  pi-mux new [--detached] [initial-request]
  pi-mux open [--temporary] <session-id>
  pi-mux state <session-id> <state> --source <JSON> --title <JSON>
  pi-mux state <session-id> --clear --source <JSON>
  pi-mux close <session-id>
  pi-mux list
  pi-mux switch <session-id> [--client-pid <pid>]
  pi-mux current [--client-pid <pid>]
  pi-mux history [--cwd <absolute-cwd>]
  pi-mux workspace register <cwd>
  pi-mux workspace unregister <cwd>
  pi-mux snapshot [server-generation]
  pi-mux restore`);
      return 0;
    }
    if (operation.kind === "state") {
      try {
        const config = tmuxConfiguration();
        prepareDirectory(config.stateDirectory);
        return await withLock(
          config,
          async () => {
            await notifyState(config, operation.id, operation.source, operation.notification);
            return 0;
          },
          "try",
        );
      } catch (error) {
        console.error(`pi-mux: state ${operation.id}: ${errorMessage(error)}`);
        return error instanceof LockBusyError ? 75 : 1;
      }
    }
    if (operation.kind === "list") {
      console.log(JSON.stringify(await listWorkspaces(tmuxConfiguration())));
      return 0;
    }
    if (operation.kind === "switch") {
      await switchSession(tmuxConfiguration(), operation.id, operation.clientPid);
      return 0;
    }
    if (operation.kind === "current") {
      console.log(JSON.stringify(await currentSession(tmuxConfiguration(), operation.clientPid)));
      return 0;
    }
    if (operation.kind === "history") {
      console.log(JSON.stringify(await historySessions(tmuxConfiguration(), operation.cwd)));
      return 0;
    }
    if (operation.kind === "close") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      return await withLock(config, async () => {
        await closeSession(config, operation.id, operation.ifTemporary);
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
      if (operation.kind === "new") {
        const preferred = await configuredSessionRoot(config);
        if (preferred) rememberSessionRoot(config, preferred);
      }
      let temporaryTarget: string | undefined;
      if (operation.kind === "open" && operation.temporary) {
        const selected = await resolveSaved(config, operation.id);
        if (!selected.running && !selected.managed) temporaryTarget = operation.id;
      }
      const failures = await startAndRestore(config, operation.kind === "restore", temporaryTarget);
      if (operation.kind === "restore") return failures > 0 ? 2 : 0;
      const target =
        operation.kind === "open"
          ? await openSaved(config, operation.id, operation.temporary ? "temporary" : "normal")
          : operation.request === undefined
            ? await openNew(config)
            : await createIndependent(config, operation.request);
      if (operation.kind === "open") {
        try {
          if (!operation.temporary) await promoteSession(config, target.session, target.id);
          await snapshotSessions(config, undefined, "repair");
        } catch (error) {
          throw new Error(`Cannot update open session ${operation.id}: ${errorMessage(error)}`);
        }
      }
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
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return { kind: "help" };
  if (argv.length === 0) return { kind: "new", detached: false };
  if (argv[0] === "new") {
    const detached = argv[1] === "--detached";
    const requests = argv.slice(detached ? 2 : 1);
    const request = requests[0];
    if (requests.length === 0) return { kind: "new", detached };
    if (requests.length === 1 && request?.trim() && !request.includes("\0"))
      return { kind: "new", detached, request };
  }
  if (argv[0] === "state") return parseStateOperation(argv);
  if (argv[0] === "open") {
    const temporary = argv[1] === "--temporary";
    const id = argv[temporary ? 2 : 1];
    if (argv.length === (temporary ? 3 : 2) && id && SESSION_ID_PATTERN.test(id))
      return { kind: "open", id, temporary };
  }
  if (argv[0] === "close") {
    const conditional = argv[1] === "--if-temporary";
    const id = argv[conditional ? 2 : 1];
    if (argv.length === (conditional ? 3 : 2) && id && SESSION_ID_PATTERN.test(id))
      return { kind: "close", id, ifTemporary: conditional };
  }
  if (
    argv.length === 3 &&
    argv[0] === "workspace" &&
    (argv[1] === "register" || argv[1] === "unregister") &&
    argv[2]?.trim() &&
    !argv[2].includes("\0")
  )
    return { kind: "workspace", action: argv[1], cwd: resolve(argv[2]) };
  if (argv.length === 1 && argv[0] === "list") return { kind: "list" };
  if (argv[0] === "switch") {
    const id = argv[1];
    const pid = argv[2] === "--client-pid" ? argv[3] : undefined;
    if (
      id &&
      SESSION_ID_PATTERN.test(id) &&
      ((argv.length === 2 && pid === undefined) ||
        (argv.length === 4 && pid !== undefined && /^[1-9]\d*$/.test(pid)))
    )
      return { kind: "switch", id, clientPid: pid === undefined ? undefined : Number(pid) };
  }
  if (argv[0] === "current") {
    const pid = argv[1] === "--client-pid" ? argv[2] : undefined;
    if (argv.length === 1 || (argv.length === 3 && pid !== undefined && /^[1-9]\d*$/.test(pid)))
      return { kind: "current", clientPid: pid === undefined ? undefined : Number(pid) };
  }
  if (argv[0] === "history") {
    const cwd = argv[1] === "--cwd" ? argv[2] : undefined;
    if (argv.length === 1 || (argv.length === 3 && cwd !== undefined && isAbsolute(cwd)))
      return { kind: "history", cwd };
  }
  if (argv.length === 1 && argv[0] === "restore") return { kind: "restore" };
  if ((argv.length === 1 || argv.length === 2) && argv[0] === "snapshot")
    return { kind: "snapshot", generation: argv[1] };
  throw new Error(
    "usage: pi-mux [new [--detached] [initial-request] | open [--temporary] <session-id> | state <session-id> <state> --source <JSON> --title <JSON> | state <session-id> --clear --source <JSON> | close <session-id> | list | switch <session-id> [--client-pid <pid>] | current [--client-pid <pid>] | history [--cwd <absolute-cwd>] | workspace register|unregister <cwd> | snapshot [server-generation] | restore]",
  );
}

function parseStateOperation(argv: string[]): Operation {
  const id = argv[1];
  try {
    if (!id || !SESSION_ID_PATTERN.test(id)) throw new Error("Invalid complete conversation ID");
    const clear = argv[2] === "--clear";
    const state = argv[2];
    if (!clear && state !== "running" && state !== "waiting-approval" && state !== "waiting-user")
      throw new Error("Invalid state");
    const options = new Map<string, unknown>();
    for (let index = 3; index < argv.length; index += 2) {
      const key = argv[index]!;
      const value = argv[index + 1];
      if ((key !== "--source" && key !== "--title") || options.has(key) || value === undefined)
        throw new Error("Missing, duplicate, or unexpected state argument");
      options.set(key, JSON.parse(value));
    }
    if (!options.has("--source") || (clear ? options.has("--title") : !options.has("--title")))
      throw new Error("State requires source and title; clear requires only source");
    const source = options.get("--source");
    if (
      !isRecord(source) ||
      typeof source.socket !== "string" ||
      !isAbsolute(source.socket) ||
      !Number.isSafeInteger(source.serverPid) ||
      Number(source.serverPid) <= 0 ||
      typeof source.serverStartTime !== "string" ||
      !/^\d+$/.test(source.serverStartTime) ||
      typeof source.pane !== "string" ||
      !/^%\d+$/.test(source.pane) ||
      !Number.isSafeInteger(source.pid) ||
      Number(source.pid) <= 0 ||
      typeof source.started !== "string" ||
      !/^\d+$/.test(source.started)
    )
      throw new Error("Invalid source");
    const title = options.get("--title");
    if (!clear && title !== null && typeof title !== "string") throw new Error("Invalid title");
    return {
      kind: "state",
      id,
      source: {
        socket: source.socket,
        serverPid: Number(source.serverPid),
        serverStartTime: source.serverStartTime,
        pane: source.pane,
        pid: Number(source.pid),
        started: source.started,
      },
      notification: clear
        ? { clear: true }
        : { clear: false, state: state as SessionState, title: title as string | null },
    };
  } catch (error) {
    throw new Error(`state ${id ?? "<missing>"}: ${errorMessage(error)}`);
  }
}

async function isTemporarySession(
  config: TmuxConfig,
  session: string,
  id: string,
  allowMissing = false,
): Promise<boolean> {
  const result = await tmux(config, ["show-environment", "-t", session, "PI_TMUX_TEMPORARY"], true);
  if (result.exitCode !== 0) {
    if (result.stderr.includes("unknown variable: PI_TMUX_TEMPORARY")) return false;
    if (
      allowMissing &&
      (serverIsAbsent(config, result.stderr) ||
        result.stderr.includes("no such session:") ||
        result.stderr.includes("can't find session:"))
    )
      return false;
    throw new Error(`Cannot inspect temporary session ${session}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim() === `PI_TMUX_TEMPORARY=${id}`;
}

async function promoteSession(config: TmuxConfig, session: string, id: string): Promise<void> {
  if (await isTemporarySession(config, session, id))
    await tmux(config, ["set-environment", "-u", "-t", session, "PI_TMUX_TEMPORARY"]);
}

async function notifyState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<void> {
  if (source.socket !== config.socket)
    throw new Error("Source socket does not match the dedicated socket");
  const server = await tmux(config, [
    "display-message",
    "-p",
    "-t",
    source.pane,
    "#{pid}:#{pane_id}",
  ]);
  const [serverPid, paneId] = server.stdout.trimEnd().split(":");
  if (
    Number(serverPid) !== source.serverPid ||
    paneId !== source.pane ||
    processStartTime(source.serverPid) !== source.serverStartTime
  )
    throw new Error("Source server or pane lifetime no longer matches");
  const session = (
    await tmux(config, ["display-message", "-p", "-t", source.pane, "#{session_id}"])
  ).stdout.trimEnd();
  if (!/^\$\d+$/.test(session)) throw new Error("Source server or pane lifetime no longer matches");
  await verifyStateTarget(config, id, source);
  const owner = JSON.stringify({ id, ...source });
  const outcome = await runGuardedStateCommands(config, source, {
    id,
    owner,
    notification,
    session,
  });
  if (outcome === "rejected") throw new Error("Source server or pane lifetime no longer matches");
  if (notification.clear || notification.state !== "running") return;
  if (await serverOption(config, "@pi-mux-generation"))
    await snapshotSessions(config, undefined, "repair");
}

function shLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function verifyStateTarget(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<void> {
  const result = await tmux(config, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{@pi-tmux-session}|#{pane_pid}|#{pane_dead}",
  ]);
  const matching = result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pane, encoded, panePid, dead] = line.split("|");
      if (dead !== "0" || !pane || !encoded) return [];
      let metadata: { id?: unknown; pid?: unknown; processPid?: unknown; startup?: unknown };
      try {
        metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      } catch {
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      }
      if (
        metadata.id !== id ||
        (metadata.startup !== "accepted" &&
          metadata.startup !== "ready" &&
          metadata.startup !== undefined) ||
        !panePid ||
        !/^[1-9]\d*$/.test(panePid)
      )
        return [];
      const pid = typeof metadata.processPid === "number" ? metadata.processPid : Number(panePid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return [];
      return [{ pane, pid }];
    });
  if (matching.length !== 1 || matching[0]!.pane !== source.pane || matching[0]!.pid !== source.pid)
    throw new Error("Source Pi process does not match the conversation and pane");
  if (processStartTime(source.pid) !== source.started)
    throw new Error("Source Pi process does not match the conversation and pane");
}

function sourceEntityGuard(config: TmuxConfig, source: StateSource): string {
  const processStartOf = (pid: string) =>
    `"$(sed 's/.*) //' /proc/${pid}/stat | awk '{print $20}')"`;
  const sessionProcess = `p=$(tmux -S ${shLiteral(config.socket)} show-options -pqv -t ${shLiteral(source.pane)} '@pi-tmux-session' 2>/dev/null | base64 -d 2>/dev/null | sed -n 's/.*"processPid":\\([0-9][0-9]*\\).*/\\1/p')`;
  return [
    `[ "#{socket_path}" = ${shLiteral(config.socket)} ]`,
    `[ "#{pid}" = ${String(source.serverPid)} ]`,
    `[ ${processStartOf("#{pid}")} = ${shLiteral(source.serverStartTime)} ]`,
    `[ "#{pane_id}" = ${shLiteral(source.pane)} ]`,
    sessionProcess,
    "case $p in ''|*[!0-9]*) p=#{pane_pid};; esac",
    `[ "$p" = ${String(source.pid)} ]`,
    `[ ${processStartOf("$p")} = ${shLiteral(source.started)} ]`,
  ].join(" && ");
}

function guardedTmuxLine(
  pane: string,
  guard: string,
  whenTrue: string[][],
  elseMarker?: string,
): string {
  const quoted = [
    "if-shell",
    "-t",
    pane,
    guard,
    whenTrue.map((args) => tmuxArguments(args)).join(" ; "),
  ];
  if (elseMarker !== undefined) quoted.push(tmuxArguments(["display-message", "-p", elseMarker]));
  return tmuxArguments(quoted);
}

async function runGuardedStateCommands(
  config: TmuxConfig,
  source: StateSource,
  plan: {
    id: string;
    owner: string;
    notification: StateNotification;
    session: string;
  },
): Promise<"written" | "skipped" | "rejected"> {
  const entity = sourceEntityGuard(config, source);
  const pane = source.pane;
  const lines: string[] = [];
  if (plan.notification.clear) {
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [["display-message", "-p", "PI_MUX_ENTITY_OK"]],
        "PI_MUX_STATE_REJECTED",
      ),
    );
    const ownerGuard = `[ "$(tmux -S ${shLiteral(config.socket)} show-options -pqv -t ${shLiteral(pane)} '@pi-mux-state-source' 2>/dev/null)" = ${shLiteral(plan.owner)} ]`;
    lines.push(
      guardedTmuxLine(
        pane,
        `${entity} && ${ownerGuard}`,
        [
          ["set-option", "-pu", "-t", pane, "@pi_session_state"],
          ["set-option", "-pu", "-t", pane, "@pi-mux-state-source"],
          ["display-message", "-p", "PI_MUX_STATE_WRITTEN"],
        ],
        "PI_MUX_SKIPPED",
      ),
    );
  } else {
    const stateValue = JSON.stringify({
      version: 1,
      sessionId: plan.id,
      state: plan.notification.state,
      title: plan.notification.title,
    });
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [
          ["set-option", "-p", "-t", pane, "@pi-mux-state-source", plan.owner],
          ["set-option", "-p", "-t", pane, "@pi_session_state", stateValue],
          ["display-message", "-p", "PI_MUX_STATE_WRITTEN"],
        ],
        "PI_MUX_STATE_REJECTED",
      ),
    );
    if (plan.notification.state === "running") {
      const temporaryGuard = `[ "$(tmux -S ${shLiteral(config.socket)} show-environment -t ${shLiteral(plan.session)} PI_TMUX_TEMPORARY 2>/dev/null)" = ${shLiteral(`PI_TMUX_TEMPORARY=${plan.id}`)} ]`;
      lines.push(
        guardedTmuxLine(pane, `${entity} && ${temporaryGuard}`, [
          ["set-environment", "-u", "-t", plan.session, "PI_TMUX_TEMPORARY"],
          ["display-message", "-p", "PI_MUX_PROMOTED"],
        ]),
      );
    }
  }
  const result = await tmux(config, ["source-file", "-"], false, `${lines.join("\n")}\n`);
  const markers = result.stdout.trim().split("\n").filter(Boolean);
  if (markers.includes("PI_MUX_STATE_REJECTED")) return "rejected";
  if (markers.includes("PI_MUX_STATE_WRITTEN")) return "written";
  return plan.notification.clear ? "skipped" : "rejected";
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

class LockBusyError extends Error {}

async function withLock<T>(
  config: TmuxConfig,
  action: () => Promise<T>,
  mode: "wait" | "try" = "wait",
): Promise<T> {
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
      if (mode === "try") throw new LockBusyError("Another pi-mux operation holds the lock");
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

async function startAndRestore(
  config: Config,
  restoreRequested: boolean,
  temporaryTarget?: string,
): Promise<number> {
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
    failures = await restoreSessions(config, generation, temporaryTarget);
  } catch (error) {
    console.error(`pi-mux: restore failed: ${errorMessage(error)}`);
    failures++;
  }
  await tmux(config, ["set-option", "-g", "@pi-mux-restored", generation]);
  return failures;
}

async function restoreSessions(
  config: Config,
  generation: string,
  temporaryTarget?: string,
): Promise<number> {
  const previous = readSnapshot(config);
  const temporaryIds = new Set(
    (await managedSessions(config)).filter((entry) => entry.temporary).map((entry) => entry.id),
  );
  if (temporaryTarget) temporaryIds.add(temporaryTarget);
  const candidates = uniqueCandidates(previous?.sessions ?? []).filter(
    (entry) => !temporaryIds.has(entry.id),
  );
  let state: RestoreState = { version: 1, generation, sessions: candidates };
  await setRestoringSessions(config, candidates);
  writeSnapshot(config, state);
  let failures = 0;
  for (const candidate of candidates) {
    try {
      const saved = await findSaved(config, candidate.id, "restore");
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

async function snapshotSessions(
  config: TmuxConfig,
  expectedGeneration?: string,
  mode: "existing" | "repair" = "existing",
): Promise<void> {
  const generation = await serverOption(config, "@pi-mux-generation");
  if (!generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  if (expectedGeneration !== undefined && generation !== expectedGeneration) return;
  const previous = readSnapshot(config);
  if (previous && previous.generation !== generation) {
    if (mode === "repair") throw new Error("Snapshot belongs to another server generation");
    return;
  }
  if (!previous && mode === "existing") return;
  const managed = await managedSessions(config);
  const temporaryIds = new Set(managed.filter((entry) => entry.temporary).map((entry) => entry.id));
  const restoring = await Promise.all(
    (previous?.sessions ?? [])
      .filter((candidate) => !temporaryIds.has(candidate.id))
      .map(async (candidate) => {
        const marker = await serverOption(config, `@pi-mux-restoring-${candidate.id}`);
        if (marker && marker !== "1") throw new Error("Invalid in-memory restore state");
        return marker ? [candidate] : [];
      }),
  );
  const sessions = uniqueCandidates([
    ...restoring.flat(),
    ...managed.filter((entry) => !entry.temporary).map(({ id, cwd }) => ({ id, cwd })),
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
    sessions.push({ id, cwd, session, temporary: await isTemporarySession(config, session, id) });
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

async function resolveSaved(config: Config, id: string) {
  const managed = (await managedSessions(config)).filter((session) => session.id === id);
  if (managed.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const running = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  if (running.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const saved = await findSaved(config, id);
  if (!running[0] && !managed[0]) {
    if (!saved) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (!existsSync(saved.cwd) || !statSync(saved.cwd).isDirectory())
      throw new Error(`Session working directory does not exist: ${saved.cwd}`);
  }
  return { running: running[0], managed: managed[0], saved };
}

async function openSaved(
  config: Config,
  id: string,
  mode: "normal" | "temporary" = "normal",
): Promise<Pane> {
  const { running, managed, saved } = await resolveSaved(config, id);
  if (running) return running;
  if (managed) return await waitForSession(config, managed.session, id);
  if (!saved) throw new Error(`Session not found (use the complete ID): ${id}`);
  const name = sessionName(id);
  const created = await createSession(config, { ...saved, temporary: mode === "temporary" }, name);
  return await waitForSession(config, created ?? name, id);
}

async function createSession(
  config: Config,
  session: { id: string; cwd: string; file?: string; request?: string; temporary?: boolean },
  name: string,
): Promise<string | undefined> {
  const startupCommand =
    session.request === undefined ? `pi-mux-startup-${randomUUID()}` : undefined;
  const desired = {
    ...config.env,
    PI_TMUX_SESSION_ID: session.id,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: session.id } : {}),
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
  const saved = panes.filter((pane) => existsSync(pane.file));
  const unsaved = panes.filter((pane) => !existsSync(pane.file));
  const sessions = await Promise.all(
    saved.map(async ({ id, cwd, file, pane, session }) => {
      const metadata = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        pane,
        "@pi_session_state",
      ]);
      const temporary = await isTemporarySession(config, session, id, true);
      return {
        cwd,
        session: {
          id,
          file,
          ...parseSessionMetadata(metadata.stdout, id, file),
          ...(temporary ? { temporary: true as const } : {}),
        } satisfies ListedSession,
      };
    }),
  );
  const empty = await Promise.all(
    unsaved.map(async ({ id, cwd, file, session }) => {
      const temporary = await isTemporarySession(config, session, id, true);
      return {
        cwd,
        session: {
          id,
          file,
          ...(temporary ? { temporary: true as const } : {}),
        } satisfies EmptySession,
      };
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
      { cwd, sessions: [], empty: [] },
    ]),
  );
  for (const { cwd, session } of sessions) workspaces.get(cwd)?.sessions.push(session);
  for (const { cwd, session } of empty) workspaces.get(cwd)?.empty.push(session);
  return [...workspaces.values()];
}

async function tmuxClients(config: TmuxConfig): Promise<TmuxClient[]> {
  const result = await tmux(
    config,
    ["list-clients", "-F", "#{client_name}\t#{client_pid}\t#{client_session}"],
    true,
  );
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr) || result.stderr.includes("no clients")) return [];
    throw new Error(`Cannot list tmux clients: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [name, pid, session] = line.split("\t");
      if (!name || !pid || !/^[1-9]\d*$/.test(pid) || !session)
        throw new Error(`Invalid tmux client output: ${line}`);
      return [{ name, pid: Number(pid), session }];
    });
}

function processParentPid(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const ppid = /^PPid:\s+(\d+)$/m.exec(status);
    return ppid ? Number(ppid[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveClient(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<TmuxClient> {
  const clients = await tmuxClients(config);
  const matching =
    clientPid === undefined
      ? clients
      : clients.filter(
          (client) => client.pid === clientPid || processParentPid(client.pid) === clientPid,
        );
  if (matching.length !== 1)
    throw new Error(
      clientPid === undefined
        ? `Expected one attached tmux client, found ${matching.length}`
        : `Cannot identify the tmux client for process ${clientPid}`,
    );
  return matching[0]!;
}

async function switchSession(
  config: TmuxConfig,
  id: string,
  clientPid: number | undefined,
): Promise<void> {
  const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  if (targets.length === 0) throw new Error(`Session not found (use the complete ID): ${id}`);
  if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const client = await resolveClient(config, clientPid);
  await tmux(config, ["switch-client", "-c", client.name, "-t", `=${targets[0]!.name}`]);
}

async function currentSession(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<CurrentSession> {
  const client = await resolveClient(config, clientPid);
  const pane = (await livePanes(config, "list")).find(
    (pane) => pane.active && pane.name === client.session,
  );
  if (!pane)
    throw new Error(`The tmux client ${client.name} does not show a pi pane: ${client.session}`);
  return { id: pane.id, cwd: pane.cwd, file: pane.file, target: pane.name };
}

function sessionGroupName(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

async function historySessions(
  config: TmuxConfig,
  cwdFilter: string | undefined,
): Promise<HistoryEntry[]> {
  const registered = Object.keys(readMembershipStore(config)["active-workspaces"]);
  const cwds = cwdFilter === undefined ? registered : registered.filter((cwd) => cwd === cwdFilter);
  if (cwds.length === 0) return [];
  const targetCwds = new Set(cwds);
  const groups = [
    ...new Set(cwds.map((cwd) => join(config.agentDir, "sessions", sessionGroupName(cwd)))),
  ];
  const { customRoot, layers } = await savedSessionLayers(config, groups);
  const listed = await Promise.all(
    layers.flatMap(({ directories, archived }) =>
      directories.map(async (directory) =>
        (await sessionFiles(directory)).map((file) => ({ file, archived })),
      ),
    ),
  );
  const history: HistoryEntry[] = [];
  const normalIds = new Set<string>();
  const summaries = new HistorySummaryCache();
  for (const { file, archived } of listed.flat()) {
    let header: ReturnType<typeof readHeader>;
    try {
      header = readHeader(file);
    } catch {
      continue;
    }
    const btime = parseEpochMs(header?.timestamp);
    if (
      header?.type !== "session" ||
      typeof header.id !== "string" ||
      !SESSION_ID_PATTERN.test(header.id) ||
      typeof header.cwd !== "string" ||
      !isAbsolute(header.cwd) ||
      btime === undefined
    )
      continue;
    if (customRoot && !targetCwds.has(header.cwd)) continue;
    if (archived && normalIds.has(header.id)) continue;
    if (!archived) normalIds.add(header.id);
    const stat = statSync(file);
    const summary = summaries.resolve(file);
    history.push({
      id: header.id,
      cwd: header.cwd,
      file,
      title: summary.title,
      btime,
      mtime: summary.mtime,
      size: stat.size,
    });
  }
  return history.sort(
    (a, b) =>
      (b.mtime ?? Number.NEGATIVE_INFINITY) - (a.mtime ?? Number.NEGATIVE_INFINITY) ||
      a.file.localeCompare(b.file),
  );
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

async function closeSession(config: TmuxConfig, id: string, ifTemporary = false): Promise<void> {
  try {
    const panes = await livePanes(config, "list");
    const running = panes.filter((pane) => pane.id === id);
    const managed = (await managedSessions(config)).filter((session) => session.id === id);
    if (running.length > 1 || managed.length > 1)
      throw new Error("Multiple pi processes match the conversation ID");
    const initializing = await initializingPanes(config, managed, panes);
    const targets = [...running, ...initializing];
    if (targets.length > 1) throw new Error("Multiple pi processes match the conversation ID");
    if (ifTemporary && !(await isCloseTargetTemporary(config, running[0]?.session, managed, id)))
      return;
    readSnapshot(config);
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
        !result.stderr.includes("can't find session:") &&
        !result.stderr.includes("no such session:")
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

async function isCloseTargetTemporary(
  config: TmuxConfig,
  runningSession: string | undefined,
  managed: ManagedSession[],
  id: string,
): Promise<boolean> {
  if (runningSession && (await isTemporarySession(config, runningSession, id))) return true;
  for (const { session } of managed) if (await isTemporarySession(config, session, id)) return true;
  return false;
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
      const [pane, session, name, encoded, pid, dead, windowActive, paneActive] =
        line.split("\t");
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
          active: windowActive === "1" && paneActive === "1",
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
  file: string,
): { state: SessionState | null; title: string | null } {
  const state = parseSessionState(encoded, id);
  const published = parsePublishedTitle(encoded, id);
  const title = published !== null ? published : resolveSessionTitle(file);
  return { state, title };
}

function parseSessionState(encoded: string | undefined, id: string): SessionState | null {
  const metadata = parseSessionOption(encoded, id);
  if (!metadata) return null;
  const state = metadata.state;
  return state === "running" || state === "waiting-approval" || state === "waiting-user"
    ? state
    : null;
}

function parsePublishedTitle(encoded: string | undefined, id: string): string | null {
  const metadata = parseSessionOption(encoded, id);
  return metadata && typeof metadata.title === "string" ? metadata.title : null;
}

function parseSessionOption(
  encoded: string | undefined,
  id: string,
): { state?: unknown; title?: unknown } | undefined {
  if (!encoded) return undefined;
  let metadata: { version?: unknown; sessionId?: unknown; state?: unknown; title?: unknown } | null;
  try {
    metadata = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (metadata?.version !== 1 || metadata.sessionId !== id) return undefined;
  return metadata;
}

function resolveSessionTitle(file: string): string | null {
  return new HistorySummaryCache().resolve(file).title;
}

async function hasSession(config: Config, name: string): Promise<boolean> {
  const target = name.startsWith("$") ? name : `=${name}`;
  return (await tmux(config, ["has-session", "-t", target], true)).exitCode === 0;
}

function sessionName(id: string): string {
  return `pi-${createHash("sha256").update(id).digest("hex")}`;
}

async function configuredSessionRoot(config: TmuxConfig): Promise<string | undefined> {
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
  return override ? expandPath(override) : settings[1] || settings[0];
}

function registryDirectory(config: TmuxConfig): string {
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

type SessionDirectoryLayer = { directories: string[]; archived: boolean };
type SavedSessionLayers = { customRoot: string | undefined; layers: SessionDirectoryLayer[] };

async function savedSessionLayers(
  config: TmuxConfig,
  groups: string[],
): Promise<SavedSessionLayers> {
  const customRoot = await configuredSessionRoot(config);
  if (customRoot) return { customRoot, layers: [{ directories: [customRoot], archived: false }] };
  return {
    customRoot: undefined,
    layers: [
      { directories: groups, archived: false },
      { directories: groups.map((group) => join(group, "archive")), archived: true },
    ],
  };
}

async function cwdGroupDirectories(config: TmuxConfig): Promise<string[]> {
  const root = join(config.agentDir, "sessions");
  return (await sessionDirectoryEntries(root))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"),
    )
    .map((entry) => join(root, entry.name));
}

async function findSaved(
  config: Config,
  id: string,
  purpose: "open" | "restore" = "open",
): Promise<Session | undefined> {
  const { layers } = await savedSessionLayers(config, await cwdGroupDirectories(config));
  for (const { directories } of layers) {
    const files = [
      ...new Set(
        (await Promise.all(directories.map(sessionFiles))).flat().map((file) => realpathSync(file)),
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
    if (matches.length > 1)
      throw new Error(`Ambiguous session ID: ${id} (${matches.length} files)`);
    if (matches[0]) return matches[0];
  }
  return undefined;
}

async function sessionFiles(directory: string): Promise<string[]> {
  const entries = await sessionDirectoryEntries(directory);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(directory, entry.name));
}

async function sessionDirectoryEntries(directory: string) {
  return await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function readHeader(
  path: string,
): { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown } | undefined {
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

function tmuxArguments(args: string[]): string {
  return args.map(quoteTmuxArgument).join(" ");
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
