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
import { HistorySummaryCache } from "./history-summary";
import { platform } from "./platform";

type Operation =
  | { kind: "help" }
  | { kind: "new"; detached: boolean; clientPid?: number; request?: string; cwd?: string }
  | { kind: "open"; id: string; temporary: boolean }
  | { kind: "state"; id: string; source: StateSource; notification: StateNotification }
  | { kind: "close"; id: string; ifTemporary: boolean }
  | { kind: "list" }
  | { kind: "switch"; id: string; clientPid: number | undefined }
  | { kind: "current"; clientPid: number | undefined }
  | { kind: "history"; cwd: string | undefined }
  | { kind: "workspace"; action: "register" | "unregister"; cwd: string }
  | { kind: "snapshot"; generation?: string }
  | { kind: "restore" }
  | { kind: "restart"; force: boolean };
type Candidate = { id: string; cwd: string };
type ManagedSession = Candidate & { session: string; temporary: boolean };
type StateSource = {
  socket: string;
  serverPid: number;
  pane: string;
  pid: number;
  token: string;
};
type StateNotification =
  | { clear: true }
  | { clear: false; state: SessionState; title: string | null };
type RestoreState = {
  version: 1;
  generation: string;
  cwds: string[];
  sessions: Candidate[];
};
type Workspace = { cwd: string; sessions: string[] };
type Snapshot = {
  version: 1;
  generation: string;
  workspaces: Workspace[];
};
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
  btime: number | null;
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
  "PI_TMUX_LAUNCH_TOKEN",
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
  pi-mux new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request]
  pi-mux open [--temporary] <session-id>
  pi-mux state <session-id> <state> --source <JSON> --title <JSON>
  pi-mux state <session-id> --clear --source <JSON>
  pi-mux close [--if-temporary] <session-id>
  pi-mux list
  pi-mux switch <session-id> [--client-pid <pid>]
  pi-mux current [--client-pid <pid>]
  pi-mux history [--cwd <absolute-cwd>]
  pi-mux workspace register <cwd>
  pi-mux workspace unregister <cwd>
  pi-mux snapshot [server-generation]
  pi-mux restore
  pi-mux restart [--force]`);
      return 0;
    }
    if (operation.kind === "state") {
      let config: TmuxConfig | undefined;
      try {
        const activeConfig = tmuxConfiguration();
        config = activeConfig;
        prepareDirectory(activeConfig.stateDirectory);
        return await withLock(
          activeConfig,
          async () => {
            await notifyState(activeConfig, operation.id, operation.source, operation.notification);
            return 0;
          },
          "try",
        );
      } catch (error) {
        if (
          error instanceof LockBusyError &&
          config &&
          !operation.notification.clear &&
          operation.notification.state !== "waiting-user"
        ) {
          try {
            await deferRestartBlockingState(config, operation.id, operation.source);
          } catch (deferredError) {
            console.error(`pi-mux: state ${operation.id}: ${errorMessage(deferredError)}`);
          }
        }
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
    if (operation.kind === "restart" && process.env.TMUX?.split(",")[0] === config.socket)
      throw new Error("Run restart from a terminal outside the dedicated tmux server");
    prepareDirectory(config.stateDirectory);
    if (operation.kind === "restart") return await restartServer(config, operation.force);
    if (operation.kind === "new" && operation.cwd !== undefined) {
      if (!statSync(operation.cwd).isDirectory())
        throw new Error(`Workspace is not a directory: ${operation.cwd}`);
      process.chdir(operation.cwd);
    }
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
          if (!(error instanceof SnapshotReadError))
            throw new Error(`Cannot update open session ${operation.id}: ${errorMessage(error)}`);
        }
      }
      try {
        registerWorkspaces(config, [target.cwd]);
      } catch (error) {
        if (!(error instanceof SnapshotReadError)) throw error;
        console.error(`pi-mux: workspace registration deferred: ${errorMessage(error)}`);
      }
      rememberSessionRoot(config, dirname(target.file));
      if (operation.kind === "new" && (operation.detached || operation.clientPid !== undefined)) {
        if (operation.clientPid !== undefined)
          await switchSession(config, target.id, operation.clientPid);
        const attach = platform.quoteCommand([
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
  if (argv.length === 0) return { kind: "new", detached: false, clientPid: undefined };
  if (argv[0] === "new") {
    let index = 1;
    let detached = false;
    let clientPid: number | undefined;
    let cwd: string | undefined;
    while (index < argv.length) {
      if (argv[index] === "--detached" && !detached) {
        detached = true;
        index++;
        continue;
      }
      if (
        argv[index] === "--client-pid" &&
        clientPid === undefined &&
        /^[1-9]\d*$/.test(argv[index + 1] ?? "")
      ) {
        clientPid = Number(argv[index + 1]);
        index += 2;
        continue;
      }
      const cwdValue = argv[index + 1];
      if (argv[index] === "--cwd" && cwd === undefined && cwdValue !== undefined && isAbsolute(cwdValue)) {
        cwd = cwdValue;
        index += 2;
        continue;
      }
      break;
    }
    const requests = argv.slice(index);
    const request = requests[0];
    if (requests.length === 0) return { kind: "new", detached, clientPid, cwd };
    if (requests.length === 1 && request?.trim() && !request.includes("\0")) {
      if (request === "-h" || request === "--help") return { kind: "help" };
      return { kind: "new", detached, clientPid, request, cwd };
    }
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
  if (argv[0] === "restart" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--force")))
    return { kind: "restart", force: argv[1] === "--force" };
  if (argv.length === 1 && argv[0] === "restore") return { kind: "restore" };
  if ((argv.length === 1 || argv.length === 2) && argv[0] === "snapshot")
    return { kind: "snapshot", generation: argv[1] };
  throw new Error(
    "usage: pi-mux [new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request] | open [--temporary] <session-id> | state <session-id> <state> --source <JSON> --title <JSON> | state <session-id> --clear --source <JSON> | close [--if-temporary] <session-id> | list | switch <session-id> [--client-pid <pid>] | current [--client-pid <pid>] | history [--cwd <absolute-cwd>] | workspace register|unregister <cwd> | snapshot [server-generation] | restore | restart [--force]]",
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
      typeof source.pane !== "string" ||
      !/^%\d+$/.test(source.pane) ||
      !Number.isSafeInteger(source.pid) ||
      Number(source.pid) <= 0 ||
      typeof source.token !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.token)
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
        pane: source.pane,
        pid: Number(source.pid),
        token: source.token,
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

async function verifyStateSource(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<{ session: string; panePid: number }> {
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
  if (Number(serverPid) !== source.serverPid || paneId !== source.pane)
    throw new Error("Source server or pane lifetime no longer matches");
  const session = (
    await tmux(config, ["display-message", "-p", "-t", source.pane, "#{session_id}"])
  ).stdout.trimEnd();
  if (!/^\$\d+$/.test(session)) throw new Error("Source server or pane lifetime no longer matches");
  const target = await verifyStateTarget(config, id, source);
  return { session, panePid: target.panePid };
}

async function deferRestartBlockingState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<void> {
  const { panePid } = await verifyStateSource(config, id, source);
  const pending = guardedTmuxLine(
    source.pane,
    paneEntityGuard(source.serverPid, source.pane, panePid),
    [
      ["set-option", "-p", "-t", source.pane, "@pi-mux-pending-restart-blocker", "1"],
      ["set-option", "-g", "@pi-mux-restart-veto", randomUUID()],
    ],
  );
  await tmux(config, ["source-file", "-"], false, `${pending}\n`);
}

async function notifyState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<void> {
  const { session, panePid } = await verifyStateSource(config, id, source);
  const owner = JSON.stringify({ id, ...source });
  if (notification.clear) {
    const currentOwner = await tmux(config, [
      "show-options",
      "-pqv",
      "-t",
      source.pane,
      "@pi-mux-state-source",
    ]);
    if (currentOwner.stdout.trimEnd() !== owner) return;
  }
  await runGuardedStateCommands(config, source, {
    id,
    owner,
    notification,
    session,
    panePid,
  });
  if (notification.clear || notification.state !== "running") return;
  if (await serverOption(config, "@pi-mux-generation"))
    await snapshotSessions(config, undefined, "repair");
}

function paneEntityGuard(serverPid: number, pane: string, panePid: number): string {
  return `#{&&:#{==:#{pid},${serverPid}},#{&&:#{==:#{pane_id},${pane}},#{==:#{pane_pid},${panePid}}}}`;
}

function guardedTmuxLine(
  pane: string,
  condition: string,
  whenTrue: string[][],
  elseMarker?: string,
): string {
  const quoted = [
    "if-shell",
    "-t",
    pane,
    "-F",
    condition,
    whenTrue.map((args) => tmuxArguments(args)).join(" ; "),
  ];
  if (elseMarker !== undefined) quoted.push(tmuxArguments(["display-message", "-p", elseMarker]));
  return tmuxArguments(quoted);
}
async function verifyStateTarget(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<{ pane: string; pid: number; panePid: number }> {
  const result = await tmux(config, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}|#{@pi-tmux-session}|#{pane_pid}|#{pane_dead}|#{@pi-mux-launch}",
  ]);
  const matching = result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [pane, encoded, panePid, dead, launchEncoded] = line.split("|");
      if (dead !== "0" || !pane || !encoded) return [];
      let metadata: {
        id?: unknown;
        pid?: unknown;
        processPid?: unknown;
        startup?: unknown;
        token?: unknown;
      };
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
      const token = launchRecordToken(launchEncoded) ?? metadata.token;
      return [{ pane, pid, panePid: Number(panePid), token }];
    });
  if (
    matching.length !== 1 ||
    matching[0]!.pane !== source.pane ||
    matching[0]!.pid !== source.pid ||
    matching[0]!.token !== source.token
  )
    throw new Error("Source Pi process does not match the conversation and pane");
  return matching[0]!;
}

function launchRecordToken(launch: string | undefined): string | undefined {
  if (!launch) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(launch);
  } catch {
    return undefined;
  }
  return isRecord(record) && typeof record.token === "string" ? record.token : undefined;
}

async function runGuardedStateCommands(
  config: TmuxConfig,
  source: StateSource,
  plan: {
    id: string;
    owner: string;
    notification: StateNotification;
    session: string;
    panePid: number;
  },
): Promise<void> {
  await verifyStateSource(config, plan.id, source);
  const entity = paneEntityGuard(source.serverPid, source.pane, plan.panePid);
  const pane = source.pane;
  const lines: string[] = [];
  if (plan.notification.clear) {
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [
          ["set-option", "-pu", "-t", pane, "@pi_session_state"],
          ["set-option", "-pu", "-t", pane, "@pi-mux-state-source"],
          ["set-option", "-pu", "-t", pane, "@pi-mux-pending-restart-blocker"],
          ["display-message", "-p", "PI_MUX_STATE_WRITTEN"],
        ],
        "PI_MUX_SOURCE_UNVERIFIED",
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
          ["set-option", "-pu", "-t", pane, "@pi-mux-pending-restart-blocker"],
          ["display-message", "-p", "PI_MUX_STATE_WRITTEN"],
        ],
        "PI_MUX_SOURCE_UNVERIFIED",
      ),
    );
    if (
      plan.notification.state === "running" &&
      (await isTemporarySession(config, plan.session, plan.id))
    )
      lines.push(
        guardedTmuxLine(pane, entity, [
          ["set-environment", "-u", "-t", plan.session, "PI_TMUX_TEMPORARY"],
          ["display-message", "-p", "PI_MUX_PROMOTED"],
        ]),
      );
  }
  const result = await tmux(config, ["source-file", "-"], false, `${lines.join("\n")}\n`);
  const markers = result.stdout.trim().split("\n").filter(Boolean);
  if (markers.includes("PI_MUX_SOURCE_UNVERIFIED"))
    throw new Error("Cannot verify source for session state update");
  if (markers.includes("PI_MUX_STATE_WRITTEN")) return;
  throw new Error("Cannot confirm session state update");
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
  const directory = join(platform.runtimeStateRoot(), "pi-tmux");
  const agentDir = expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
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
  const address = platform.lockAddress(key);
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

type ServerLifetime = { pid: number; generation: string };

async function serverLifetime(config: TmuxConfig): Promise<ServerLifetime | undefined> {
  const result = await tmux(config, ["display-message", "-p", "#{pid}"], true);
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr)) return undefined;
    throw new Error(`Cannot inspect dedicated server: ${result.stderr.trim()}`);
  }
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid dedicated server PID");
  return { pid, generation: await serverOption(config, "@pi-mux-generation") };
}

async function verifyRestartServer(config: TmuxConfig, expected: ServerLifetime): Promise<void> {
  const current = await serverLifetime(config);
  if (!current || current.pid !== expected.pid || current.generation !== expected.generation)
    throw new Error("Dedicated server changed during restart");
}

async function restartIsWaiting(config: TmuxConfig): Promise<boolean> {
  const panes = await livePanes(config, "list");
  const managed = await managedSessions(config);
  for (const session of managed)
    if (!panes.some((pane) => pane.session === session.session && pane.id === session.id))
      return false;
  const states = await tmuxQueries(
    config,
    panes.flatMap((pane) => [
      ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
      ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    ]),
  );
  return panes.every((pane, index) => {
    const result = states[index * 2]!;
    const pending = states[index * 2 + 1]!;
    if (pending.exitCode !== 0) throw new Error(`Cannot inspect pending restart state: ${pane.id}`);
    if (pending.stdout.trim()) return false;
    if (result.exitCode !== 0) throw new Error(`Cannot inspect restart state: ${pane.id}`);
    const state = parseSessionState(result.stdout.trimEnd(), pane.id);
    return pane.startup !== "accepted" && state === "waiting-user";
  });
}

async function restartServer(config: Config, force: boolean): Promise<number> {
  const original = await withLock(config, () => serverLifetime(config));
  while (true) {
    const result = await withLock(config, async () => {
      if (!original) {
        if (await serverLifetime(config))
          throw new Error("Dedicated server changed during restart");
        prepareDirectory(config.directory);
        return (await startAndRestore(config, true)) > 0 ? 2 : 0;
      }
      await verifyRestartServer(config, original);
      readSnapshot(config);
      if (!force && !(await restartIsWaiting(config))) return undefined;
      const panes = await livePanes(config, "list");
      const initializing = await initializingPanes(config, await managedSessions(config), panes);
      uniqueCandidates(panes);
      if (new Set(panes.map((pane) => pane.id)).size !== panes.length)
        throw new Error("Multiple pi processes match a restart conversation ID");
      if (!original.generation)
        throw new Error("Dedicated server has not been initialized by pi-mux");
      await tmux(config, ["set-option", "-g", "@pi-mux-restart-veto", ""]);
      await snapshotSessions(config, original.generation, "repair");
      const saved = readSnapshot(config);
      if (!saved || saved.generation !== original.generation)
        throw new Error("Cannot confirm restart snapshot");
      await setRestoringSessions(config, saved.sessions);
      await verifyRestartServer(config, original);
      if (!force && !(await restartIsWaiting(config))) return undefined;
      const stopBranch = force
        ? "kill-server"
        : tmuxArguments([
            "if-shell",
            "-F",
            "#{==:#{@pi-mux-restart-veto},}",
            "kill-server",
            "display-message -p PI_MUX_RESTART_WAIT",
          ]);
      const stopped = await tmux(config, [
        "if-shell",
        "-F",
        `#{==:#{@pi-mux-generation},${original.generation}}`,
        stopBranch,
        "display-message -p PI_MUX_RESTART_SERVER_CHANGED",
      ]);
      if (stopped.stdout.includes("PI_MUX_RESTART_WAIT")) return undefined;
      if (stopped.stdout.includes("PI_MUX_RESTART_SERVER_CHANGED"))
        throw new Error("Dedicated server changed before restart stop");
      const targets = [...panes, ...initializing].map((pane) => ({ pid: pane.pid }));
      for (const target of targets) {
        if (!platform.processIsAlive(target.pid)) continue;
        try {
          process.kill(target.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (targets.some((target) => platform.processIsAlive(target.pid))) {
        if (Date.now() >= deadline)
          throw new Error("Timed out waiting for pi to exit during restart");
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      if (await serverLifetime(config))
        throw new Error("Dedicated server did not remain stopped during restart");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true)) > 0 ? 2 : 0;
    });
    if (result !== undefined) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
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
  const invocation = compiledEntry()
    ? [process.execPath]
    : [process.execPath, fileURLToPath(import.meta.url)];
  const hookCommand = platform.hookCommand(
    [...invocation, "snapshot"],
    platform.windows
      ? { PI_CODING_AGENT_DIR: config.agentDir }
      : {
          HOME: config.env.HOME || homedir(),
          PATH: config.env.PATH || "",
          XDG_RUNTIME_DIR: dirname(config.directory),
          PI_CODING_AGENT_DIR: config.agentDir,
        },
  );
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
  let state: RestoreState = {
    ...previous,
    version: 1,
    generation,
    cwds: previous?.cwds ?? [],
    sessions: candidates,
  };
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
  if (previous && previous.generation !== "" && previous.generation !== generation) {
    if (mode === "repair") throw new Error("Snapshot belongs to another server generation");
    return;
  }
  if (!previous && mode === "existing") return;
  const managed = await managedSessions(config);
  const temporaryIds = new Set(managed.filter((entry) => entry.temporary).map((entry) => entry.id));
  const candidates = (previous?.sessions ?? []).filter(
    (candidate) => !temporaryIds.has(candidate.id),
  );
  const markers = await tmuxQueries(
    config,
    candidates.map(({ id }) => ["show-options", "-gqv", `@pi-mux-restoring-${id}`]),
  );
  const restoring = candidates.filter((_, index) => {
    const result = markers[index]!;
    if (result.exitCode !== 0) throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
    const marker = result.stdout.trim();
    if (marker && marker !== "1") throw new Error("Invalid in-memory restore state");
    return marker === "1";
  });
  const sessions = uniqueCandidates([
    ...restoring,
    ...managed.filter((entry) => !entry.temporary).map(({ id, cwd }) => ({ id, cwd })),
  ]);
  if ((await serverOption(config, "@pi-mux-generation")) !== generation)
    throw new Error("Dedicated server changed during snapshot");
  writeSnapshot(config, {
    ...previous,
    version: 1,
    generation,
    cwds: previous?.cwds ?? [],
    sessions,
  });
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
  const targets = listed.stdout.trim().split("\n").filter(Boolean);
  const attributes = await tmuxQueries(
    config,
    targets.flatMap((session) => [
      ["show-environment", "-t", session, "PI_TMUX_SESSION_ID"],
      ["display-message", "-p", "-t", session, "#{session_path}"],
      ["show-environment", "-t", session, "PI_TMUX_TEMPORARY"],
    ]),
  );
  const sessions: ManagedSession[] = [];
  for (const [index, session] of targets.entries()) {
    const environment = attributes[index * 3]!;
    if (environment.exitCode !== 0) {
      if (environment.stderr.includes("unknown variable: PI_TMUX_SESSION_ID")) continue;
      throw new Error(`Cannot inspect tmux session ${session}: ${environment.stderr.trim()}`);
    }
    const id = environment.stdout.replace(/\n$/, "").slice("PI_TMUX_SESSION_ID=".length);
    if (!SESSION_ID_PATTERN.test(id))
      throw new Error(`Invalid conversation ID in tmux session ${session}`);
    const path = attributes[index * 3 + 1]!;
    if (path.exitCode !== 0) throw new Error(`tmux display-message failed: ${path.stdout.trim()}`);
    const cwd = path.stdout.replace(/\n$/, "");
    if (!isAbsolute(cwd)) throw new Error(`Invalid working directory in tmux session ${session}`);
    const temporary = attributes[index * 3 + 2]!;
    if (
      temporary.exitCode !== 0 &&
      !temporary.stderr.includes("unknown variable: PI_TMUX_TEMPORARY")
    )
      throw new Error(`Cannot inspect temporary session ${session}: ${temporary.stderr.trim()}`);
    sessions.push({
      id,
      cwd,
      session,
      temporary: temporary.exitCode === 0 && temporary.stdout.trim() === `PI_TMUX_TEMPORARY=${id}`,
    });
  }
  return sessions;
}

async function tmuxQueries(config: TmuxConfig, commands: string[][]) {
  if (commands.length === 0) return [];
  if (platform.windows) {
    const results: Awaited<ReturnType<typeof tmux>>[] = [];
    for (const command of commands) results.push(await tmux(config, command, true));
    return results;
  }
  const args = commands.flatMap((command, index) => [
    ...(index === 0 ? [] : [";"]),
    "if-shell",
    "-F",
    "1",
    tmuxArguments(command),
  ]);
  const result = await tmux(config, ["-C", ...args], true);
  const frames = [
    ...result.stdout.matchAll(/^%begin (\d+ \d+ \d+)\n([\s\S]*?)^%(end|error) \1\n/gm),
  ];
  if (frames.length !== commands.length * 2)
    throw new Error(
      `Cannot inspect managed sessions: invalid tmux control response ${result.stderr.trim()}`,
    );
  return commands.map((_, index) => {
    const wrapper = frames[index * 2]!;
    const frame = frames[index * 2 + 1]!;
    if (wrapper[3] !== "end") throw new Error("Cannot inspect managed sessions: tmux batch failed");
    return { stdout: frame[2]!, stderr: frame[2]!, exitCode: frame[3] === "end" ? 0 : 1 };
  });
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

class SnapshotReadError extends Error {}

function readSnapshot(config: TmuxConfig): RestoreState | undefined {
  const path = snapshotPath(config);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SnapshotReadError(`Cannot read snapshot ${path}: ${errorMessage(error)}`);
  }
  const state = raw as Partial<Snapshot> | null;
  if (
    !state ||
    state.version !== 1 ||
    typeof state.generation !== "string" ||
    !Array.isArray(state.workspaces)
  )
    throw new SnapshotReadError(`Invalid snapshot: ${path}`);
  for (const workspace of state.workspaces) {
    if (
      !workspace ||
      typeof workspace.cwd !== "string" ||
      !isAbsolute(workspace.cwd) ||
      !Array.isArray(workspace.sessions)
    )
      throw new SnapshotReadError(`Invalid snapshot workspace: ${path}`);
    for (const id of workspace.sessions) {
      if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
        throw new SnapshotReadError(`Invalid snapshot candidate: ${path}`);
    }
  }
  const sessions = state.workspaces.flatMap((workspace) =>
    workspace.sessions.map((id) => ({ id, cwd: workspace.cwd })),
  );
  try {
    uniqueCandidates(sessions);
  } catch (error) {
    throw new SnapshotReadError(errorMessage(error));
  }
  if (state.generation === "" && sessions.length > 0)
    throw new SnapshotReadError(`Invalid snapshot generation: ${path}`);
  return {
    version: 1,
    generation: state.generation,
    cwds: [...new Set(state.workspaces.map(({ cwd }) => cwd))],
    sessions,
  };
}

function writeSnapshot(config: TmuxConfig, state: RestoreState): void {
  const workspaces = new Map<string, Workspace>(
    state.cwds.map((cwd) => [cwd, { cwd, sessions: [] }]),
  );
  for (const { id, cwd } of uniqueCandidates(state.sessions)) {
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

function compiledEntry(): boolean {
  return import.meta.path.startsWith("/$bunfs/") || /^[Bb]:\\+~BUN\\/i.test(import.meta.path);
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
  const launchToken = randomUUID();
  const desired = {
    ...config.env,
    PI_TMUX_SESSION_ID: session.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
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
  const paneCommand = platform.paneCommand(
    [
      config.pi,
      ...selection,
      "-e",
      config.extension,
      ...(session.request === undefined
        ? ["--", `/${startupCommand}`]
        : ["--agent", "main", "--", session.request]),
    ],
    removed,
  );
  const result = await tmux(
    config,
    [
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
      paneCommand,
    ],
    true,
  );
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
    if (!platform.processIsAlive(Number(pid)))
      throw new Error(`pi exited before launch was recorded: ${session.id}`);
    await tmux(config, [
      "set-option",
      "-p",
      "-t",
      pane,
      "@pi-mux-launch",
      JSON.stringify({ id: session.id, pid: Number(pid), token: launchToken }),
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
  const current = readSnapshot(config);
  if (panes.some(({ cwd }) => !current?.cwds.includes(cwd))) {
    prepareDirectory(config.stateDirectory);
    return await withLock(config, async () =>
      collectWorkspaceList(config, await livePanes(config, "list"), "register"),
    );
  }
  return await collectWorkspaceList(config, panes);
}

async function collectWorkspaceList(
  config: TmuxConfig,
  panes: Pane[],
  registration: "read" | "register" = "read",
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
  if (registration === "register")
    registerWorkspaces(
      config,
      panes.map(({ cwd }) => cwd),
    );
  const workspaces = new Map<string, ListedWorkspace>(
    (readSnapshot(config)?.cwds ?? []).map((cwd) => [cwd, { cwd, sessions: [], empty: [] }]),
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

async function resolveClient(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<TmuxClient> {
  const clients = await tmuxClients(config);
  const matching =
    clientPid === undefined
      ? clients
      : clients.filter(
          (client) =>
            client.pid === clientPid || platform.processParentPid(client.pid) === clientPid,
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
  const registered = readSnapshot(config)?.cwds ?? [];
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
    const summary = summaries.resolveHistory(file, (header) => {
      if (customRoot && !targetCwds.has(header.cwd)) return false;
      const shadowedByNormalCopy = archived && normalIds.has(header.id);
      return !shadowedByNormalCopy;
    });
    const header = summary?.header;
    if (!summary || !header) continue;
    if (!archived) normalIds.add(header.id);
    history.push({
      id: header.id,
      cwd: header.cwd,
      file,
      title: summary.title,
      btime: summary.btime,
      mtime: summary.mtime,
      size: summary.size,
    });
  }
  return history.sort(
    (a, b) =>
      (b.mtime ?? Number.NEGATIVE_INFINITY) - (a.mtime ?? Number.NEGATIVE_INFINITY) ||
      a.file.localeCompare(b.file),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registerWorkspaces(config: TmuxConfig, cwds: string[]): void {
  const previous = readSnapshot(config);
  const registered = [...new Set([...(previous?.cwds ?? []), ...cwds])];
  if (registered.length === previous?.cwds.length) return;
  writeSnapshot(config, {
    ...previous,
    version: 1,
    generation: previous?.generation ?? "",
    cwds: registered,
    sessions: previous?.sessions ?? [],
  });
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
        !targets.some((pane) => platform.processIsAlive(pane.pid))
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
          tmuxArguments(["kill-pane", "-t", pane.pane]),
        ],
        true,
      );
      if (result.exitCode !== 0 && platform.processIsAlive(pane.pid))
        throw new Error(`Cannot stop pi in pane ${pane.pane}: ${result.stderr.trim()}`);
    }
  }
}

async function unregisterWorkspace(config: TmuxConfig, cwd: string): Promise<void> {
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
      !targets.some((pane) => platform.processIsAlive(pane.pid))
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
      cwds: snapshot.cwds.filter((registered) => registered !== cwd),
      sessions: snapshot.sessions.filter((session) => session.cwd !== cwd),
    });
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
      const environment = platform.processEnvironment(target.pid);
      const workingDirectory =
        environment === undefined ? undefined : platform.processWorkingDirectory(target.pid);
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
        typeof launch.token !== "string"
      )
        throw new Error(`Cannot safely identify initializing pi ${session.id} in ${target.pane}`);
      if (
        (environment !== undefined &&
          (!environment.includes(`PI_TMUX_SESSION_ID=${session.id}`) ||
            !environment.includes(`PI_TMUX_LAUNCH_TOKEN=${launch.token}`))) ||
        (workingDirectory !== undefined && workingDirectory !== realpathSync(session.cwd))
      )
        continue;
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

function serverIsAbsent(config: TmuxConfig, stderr: string): boolean {
  return (
    stderr.includes("no server running on ") ||
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
      const [pane, session, name, encoded, pid, dead, windowActive, paneActive] = line.split("\t");
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
        if (
          platform.processAncestryAvailable &&
          !platform.processDescendsFrom(metadata.processPid, Number(pid))
        )
          return [];
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
  platform.assertDirectorySafety(lstatSync(path), path);
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
