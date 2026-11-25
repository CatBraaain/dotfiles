import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HistorySummaryCache,
  parseLastRun,
  readSessionHeader,
  readSessionLastRun,
  type LastRun,
} from "./history-summary";
import { platform } from "./platform";
import {
  conversationLaunchKey,
  launchBasisStillLive,
  SpawnDidNotStartError,
  ticketLaunchKey,
  type WindowsLaunchRights,
  type WindowsLaunchStatus,
  type WindowsManagementBasis,
} from "./windows-launch-rights";
import {
  inspectWindowsProcess,
  isWindowsProcessIdentity,
  observeWindowsIdentity,
  type WindowsProcessIdentity,
} from "./windows-process";
import { waitForPsmuxClient, type PsmuxPeer } from "./windows-psmux";
import { WindowsManagement } from "./windows-management";
import {
  captureWindowsProcesses,
  configureWindowsPeer,
  mutateWindowsPeerPane,
  readWindowsPeerPaneFields,
  runWindowsPeerPaneCommands,
  stopWindowsPeers,
  waitForWindowsExit,
  WINDOWS_BOOTSTRAP_PROOF,
} from "./windows-lifecycle";
import {
  isViewReceipt,
  metadataFileIdentity,
  metadataFileRevision,
  sessionMetadata,
  SessionMetadataCache,
  SessionPathChangedError,
  type UnresolvedFile,
  type ViewReceipt,
} from "./session-metadata";
import {
  getWorktreeSnapshot,
  parseWorktreeSnapshotRequest,
  type WorktreeSnapshotRequest,
} from "./worktree-snapshot";

type ListOperation =
  | { kind: "list"; scope: "all" | "active"; json: boolean }
  | { kind: "list"; scope: "saved"; cwd: string | undefined; json: boolean }
  | { kind: "list"; scope: "displayed"; clientPid: number | undefined; json: boolean };

type Operation =
  | { kind: "help" }
  | { kind: "new"; detached: boolean; clientPid?: number; request?: string; cwd?: string }
  | { kind: "open"; id: string; temporary: boolean; detached: boolean }
  | { kind: "open-exact"; id: string; file: string }
  | { kind: "inspect"; id: string }
  | { kind: "inspect-management"; socket: string }
  | { kind: "inspect-dispatch-inventory"; socket: string }
  | WindowsCreateDispatchWorker
  | { kind: "windows-claim-launch"; token: string; command: string[]; reload?: WindowsReloadRoute }
  | { kind: "metadata"; id: string; viewFile?: string }
  | { kind: "worktree-snapshot"; request: WorktreeSnapshotRequest }
  | { kind: "record-view"; id: string; receipt: ViewReceipt }
  | DispatchTicketOperation
  | { kind: "state"; id: string; source: StateSource; notification: StateNotification }
  | { kind: "send"; id: string; waitSeconds: number | undefined; text: string }
  | { kind: "close"; id: string; ifTemporary: boolean }
  | ListOperation
  | { kind: "switch"; id: string; clientPid: number | undefined }
  | { kind: "history"; cwd: string | undefined; json: boolean }
  | { kind: "workspace"; action: "register" | "unregister"; cwd: string }
  | { kind: "snapshot"; generation?: string }
  | { kind: "restore" }
  | { kind: "reload"; id?: string }
  | { kind: "restart"; force: boolean };
type DispatchTicketOperation = {
  kind: "inspect-dispatch-ticket";
  ownerId: string;
  socket: string;
  project: string;
  ticketId: string;
  sessionName: string;
  cwd: string;
  prompt: string;
};
type WindowsCreateDispatchWorker = {
  kind: "inspect-create-dispatch-worker";
  socket: string;
  generation: string;
  name: string;
  project: string;
  token: string;
  cwd: string;
  powershell: string;
  command: string;
};
type Candidate = { id: string; cwd: string };
type ManagedSession = Candidate & { session: string; temporary: boolean };
export type StateSource = {
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
  warm: boolean;
  metadata: string;
};
type StopTarget = Pick<Pane, "pane" | "pid" | "panePid">;
type PublishPending = { attemptAt: number };
type ListedSession = {
  id: string;
  file: string;
  state: SessionState | null;
  title: string | null;
  publishPending: PublishPending | null;
  lastRun?: LastRun;
  temporary?: true;
};
type EmptySession = { id: string; file: string; temporary?: true };
type ListedWorkspace = { cwd: string; sessions: ListedSession[]; empty: EmptySession[] };
type TmuxClient = { name: string; pid: number; session: string };
type DisplayedSession = Session & { clientPid: number; target: string };
type HistoryEntry = {
  id: string;
  cwd: string;
  file: string;
  title: string | null;
  btime: number | null;
  mtime: number | null;
  size: number;
};
type UnifiedSession = ListedSession & {
  active: boolean;
  saved: boolean;
  btime: number | null;
  mtime: number | null;
  size: number | null;
};
type UnifiedWorkspace = { cwd: string; sessions: UnifiedSession[] };
type Config = ReturnType<typeof configuration>;
type TmuxConfig = ReturnType<typeof tmuxConfiguration> & { noStart?: true; timeout?: number };
type SavedSessionConfig = Pick<TmuxConfig, "agentDir"> & {
  env: NodeJS.ProcessEnv;
};

const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const DISPATCH_TICKET_ID_PATTERN = /^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const DISPATCH_TICKET_ID_MAX_LENGTH = 252;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const SEND_WAIT_POLL_INTERVAL_MS = 100;
const MESSAGE_TEXT_MAX_CODE_POINTS = 2800;
const VIEW_RECEIPT_TIMEOUT_SECONDS = 5;
const VIEW_RECEIPT_MAX_ENCODED_LENGTH = 16_384;
const BASE64_OPTION_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;
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
  "PI_TMUX_FIRST_INPUT",
  "PI_MUX_WINDOWS_START_RIGHT",
  "PI_MUX_WINDOWS_BOOTSTRAP",
  "TICKET_DISPATCH_ROLE",
  "TICKET_DISPATCH_PROJECT",
  "TICKET_DISPATCH_ID",
]);
const PI_HARDWARE_CURSOR_ENV = "PI_HARDWARE_CURSOR";
const WINDOWS_RIGHT_ENV = "PI_MUX_WINDOWS_START_RIGHT";
const WINDOWS_RIGHT_OPTION = "@pi-mux-windows-start-right";
const PSMUX_ROUTING = new Set([
  "TMUX",
  "TMUX_PANE",
  "PSMUX_TARGET_SESSION",
  "PSMUX_TARGET_FULL",
  "PSMUX_ROUTE_WARM",
]);
const PANE_FORMAT =
  "#{pane_id}\t#{session_id}\t#{session_name}\t#{@pi-tmux-session}\t#{pane_pid}\t#{pane_dead}\t#{window_active}\t#{pane_active}";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const operation = parseOperation(argv);
    if (operation.kind === "help") {
      console.log(`Usage:
  pi-mux
  pi-mux -h | --help
  pi-mux new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request]
  pi-mux open [--temporary] [--detached] <session-id>
  pi-mux open --detached --expect-file <absolute-jsonl-path> <session-id>
  pi-mux inspect <session-id>
  pi-mux metadata <session-id>
  pi-mux state <session-id> <state> --source <JSON> --title <JSON>
  pi-mux state <session-id> --clear --source <JSON>
  pi-mux send [--wait <seconds>] <session-id> <text...>
  pi-mux close [--if-temporary] <session-id>
  pi-mux list [--json]
  pi-mux list --active [--json]
  pi-mux list --saved [--cwd <absolute-cwd>] [--json]
  pi-mux list --displayed [--client-pid <pid>] [--json]
  pi-mux switch <session-id> [--client-pid <pid>]
  pi-mux history [--cwd <absolute-cwd>] [--json]
  pi-mux workspace register <cwd>
  pi-mux workspace unregister <cwd>
  pi-mux snapshot [server-generation]
  pi-mux restore
  pi-mux reload [<session-id>]
  pi-mux restart [--force]`);
      return 0;
    }
    if (operation.kind === "inspect") {
      try {
        const result = await inspectSession(
          { ...tmuxConfiguration(), noStart: true },
          operation.id,
        );
        console.log(JSON.stringify(result));
        return 0;
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
        console.error(`pi-mux: Cannot inspect session ${operation.id}: ${errorMessage(error)}`);
        return 75;
      }
    }
    if (operation.kind === "inspect-management") {
      if (!platform.windows) throw new Error("This management query requires Windows");
      const config = { ...tmuxConfiguration(), noStart: true } as const;
      if (operation.socket !== config.socket)
        throw new Error("Ticket dispatch socket does not match pi-mux");
      await withLock(config, async () => {
        const management = windowsManagement(config);
        const basis = await management.currentBasis();
        if (!basis || !management.startupState(basis)?.restored)
          throw new Error("The dedicated psmux management generation is not restored and running");
        console.log(JSON.stringify({ state: "ready", generation: basis.instance }));
      });
      return 0;
    }
    if (
      operation.kind === "inspect-dispatch-inventory" ||
      operation.kind === "inspect-create-dispatch-worker"
    ) {
      if (!platform.windows) throw new Error("This dispatch operation requires Windows");
      const config = { ...tmuxConfiguration(), noStart: true } as const;
      if (operation.socket !== config.socket)
        throw new Error("Ticket dispatch socket does not match pi-mux");
      await withLock(
        config,
        async () => {
          if (operation.kind === "inspect-dispatch-inventory") {
            console.log(JSON.stringify({ sessions: await readWindowsDispatchInventory(config) }));
          } else await createWindowsDispatchWorker(config, operation);
        },
        "try",
      );
      return 0;
    }
    if (operation.kind === "windows-claim-launch") {
      if (!platform.windows) throw new Error("This launch operation requires Windows");
      return operation.reload
        ? await claimWindowsReload(operation.token, operation.command, operation.reload)
        : await claimWindowsLaunch(operation.token, operation.command);
    }
    if (operation.kind === "worktree-snapshot") {
      console.log(JSON.stringify(getWorktreeSnapshot(operation.request)));
      return 0;
    }
    if (operation.kind === "metadata") {
      const { id, viewFile } = operation;
      if (viewFile !== undefined) {
        const file = realpathSync(viewFile);
        const history = await new SessionMetadataCache(id, `view:${file}`, "").read(
          async () => file,
        );
        console.log(
          JSON.stringify({
            file,
            fileIdentity: history.identity,
            responseId: history.summary.response?.id ?? null,
          }),
        );
      } else {
        const config = { agentDir: resolveAgentDirectory(), env: process.env };
        const history = await readSessionMetadata(config, id);
        console.log(JSON.stringify(sessionMetadata(id, history.summary)));
      }
      return 0;
    }
    if (operation.kind === "record-view") {
      await sendViewReceipt(
        { ...tmuxConfiguration(), noStart: true },
        operation.id,
        operation.receipt,
      );
      return 0;
    }
    if (operation.kind === "open-exact") {
      if (!platform.windows && process.platform !== "linux")
        throw new Error("Exact session reopen requires Linux or Windows");
      const config = { ...configuration(), noStart: true } as const;
      printDetachedSession(config, await openExactSession(config, operation.id, operation.file));
      return 0;
    }
    if (operation.kind === "inspect-dispatch-ticket") {
      const result = await launchDispatchedTicket(
        { ...tmuxConfiguration(), noStart: true },
        operation,
      );
      console.log(JSON.stringify(result));
      return 0;
    }
    if (operation.kind === "state") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      try {
        return await notifyState(config, operation.id, operation.source, operation.notification);
      } catch (error) {
        console.error(`pi-mux: state ${operation.id}: ${errorMessage(error)}`);
        return 1;
      }
    }
    if (operation.kind === "send") {
      return await sendSessionMessage(
        tmuxConfiguration(),
        operation.id,
        operation.text,
        operation.waitSeconds,
      );
    }
    if (
      operation.kind === "history" ||
      (operation.kind === "list" && operation.scope === "saved")
    ) {
      const history = await historySessions(tmuxConfiguration(), operation.cwd);
      console.log(operation.json ? JSON.stringify(history) : renderHistoryTable(history));
      return 0;
    }
    if (operation.kind === "list") {
      const config = tmuxConfiguration();
      if (operation.scope === "displayed") {
        const sessions = await displayedSessions({ ...config, noStart: true }, operation.clientPid);
        console.log(
          operation.json
            ? JSON.stringify(sessions)
            : renderTable(
                ["CLIENT PID", "WORKSPACE", "SESSION ID", "TMUX TARGET", "FILE"],
                sessions.map(({ clientPid, cwd, id, target, file }) => [
                  String(clientPid),
                  cwd,
                  id,
                  target,
                  file,
                ]),
              ),
        );
        return 0;
      }
      const active = await listWorkspaces(config);
      if (operation.scope === "active") {
        console.log(operation.json ? JSON.stringify(active) : renderActiveTable(active));
      } else {
        const history = await historySessions(config, undefined);
        const unified = mergeSessionLists(active, history);
        console.log(operation.json ? JSON.stringify(unified) : renderUnifiedTable(unified));
      }
      return 0;
    }
    if (operation.kind === "switch") {
      try {
        await switchSession(tmuxConfiguration(), operation.id, operation.clientPid);
        return 0;
      } catch (error) {
        if (!(error instanceof SwitchResolutionError)) throw error;
        console.error(`pi-mux: ${error.message}`);
        return error.exitCode;
      }
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
    if (
      (operation.kind === "restart" || operation.kind === "reload") &&
      process.env.TMUX?.split(",")[0] === config.socket
    )
      throw new Error("Run restart and reload from a terminal outside the dedicated tmux server");
    prepareDirectory(config.stateDirectory);
    if (operation.kind === "restart") return await restartServer(config, operation.force);
    if (operation.kind === "reload") return await reloadPanes(config, operation.id);
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
      let bootstrap: WindowsBootstrap = "start";
      if (operation.kind === "open" && operation.temporary) {
        const selected = await resolveSaved(config, operation.id);
        if (!selected.running && !selected.managed) temporaryTarget = operation.id;
        if (platform.windows) bootstrap = selected.windowsBasis ?? "fresh";
      }
      const { failures, basis } = await startAndRestore(
        config,
        operation.kind === "restore",
        temporaryTarget,
        bootstrap,
      );
      if (operation.kind === "restore") return failures > 0 ? 2 : 0;
      const management = basis ? windowsManagement(config) : undefined;
      const target =
        operation.kind === "open"
          ? await openSaved(
              config,
              operation.id,
              operation.temporary ? "temporary" : "normal",
              basis,
            )
          : await createNew(config, operation.request, basis);
      if (management && basis) await management.assertLive(basis);
      if (operation.kind === "open") {
        try {
          if (management && target.startup === "ready") {
            if (!basis || !management.startupState(basis)?.restored)
              throw new Error("Cannot verify the Windows pi-mux startup state");
            if (management.startupState(basis)?.restoring.includes(target.id.toLowerCase()))
              await management.clearRestoring(basis, target.id, windowsClaimLock(management));
          }
          if (!operation.temporary) await promoteSession(config, target.session, target.id);
          await snapshotSessions(config, basis?.instance, "repair");
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
      if (management && basis) await management.assertLive(basis);
      const clientPid = operation.kind === "new" ? operation.clientPid : undefined;
      if (operation.detached || clientPid !== undefined) {
        if (clientPid !== undefined) {
          if (platform.windows) {
            if (!management || !basis)
              throw new Error("Missing Windows pi-mux management generation");
            await switchWindowsNewClient(config, target, clientPid, management, basis);
          } else await switchSession(config, target.id, clientPid);
        }
        printDetachedSession(config, target);
        return 0;
      }
      return target;
    });
    if (typeof result === "number") return result;
    const client = Bun.spawn(attachCommand(config, result), {
      env: config.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await client.exited;
  } catch (error) {
    console.error(`pi-mux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printDetachedSession(config: TmuxConfig, target: Pane): void {
  const attach = platform.quoteCommand(attachCommand(config, target));
  console.log(`Pi session ${target.id}\nAttach with: ${attach}`);
}

function attachCommand(config: TmuxConfig, target: Pane): string[] {
  const sessionTarget = platform.windows ? `=${target.name}` : target.session;
  return [config.tmux, "-S", config.socket, "attach-session", "-t", sessionTarget];
}

function mergeSessionLists(active: ListedWorkspace[], history: HistoryEntry[]): UnifiedWorkspace[] {
  const workspaces = new Map<string, UnifiedWorkspace>(
    active.map(({ cwd }) => [cwd, { cwd, sessions: [] }]),
  );
  const savedById = new Map<string, HistoryEntry>();
  for (const entry of history) {
    if (!savedById.has(entry.id)) savedById.set(entry.id, entry);
  }

  const seenActive = new Set<string>();
  for (const { cwd, sessions, empty } of active) {
    const workspace = workspaces.get(cwd)!;
    const entries: (EmptySession & Partial<ListedSession>)[] = [...sessions, ...empty];
    for (const entry of entries) {
      if (seenActive.has(entry.id)) continue;
      seenActive.add(entry.id);
      const saved = savedById.get(entry.id);
      const hasLiveFile = "state" in entry;
      workspace.sessions.push({
        id: entry.id,
        file: saved?.file ?? entry.file,
        active: true,
        saved: hasLiveFile || saved !== undefined,
        state: entry.state ?? null,
        title: entry.title ?? saved?.title ?? null,
        publishPending: entry.publishPending ?? null,
        ...(entry.lastRun ? { lastRun: entry.lastRun } : {}),
        btime: saved?.btime ?? null,
        mtime: saved?.mtime ?? null,
        size: saved?.size ?? null,
        ...(entry.temporary ? { temporary: true } : {}),
      });
      savedById.delete(entry.id);
    }
  }

  for (const { cwd, ...entry } of savedById.values()) {
    let workspace = workspaces.get(cwd);
    if (!workspace) {
      workspace = { cwd, sessions: [] };
      workspaces.set(cwd, workspace);
    }
    workspace.sessions.push({
      ...entry,
      active: false,
      saved: true,
      state: null,
      publishPending: null,
    });
  }

  return [...workspaces.values()];
}

function renderUnifiedTable(workspaces: UnifiedWorkspace[]): string {
  const rows = workspaces.flatMap(({ cwd, sessions }) =>
    sessions.map(({ id, active, saved, state, mtime, title }) => {
      const status = !active ? "inactive" : !saved ? "unsaved" : (state ?? "active");
      return [cwd, id, status, formatUpdatedAt(mtime), title];
    }),
  );
  return renderTable(["WORKSPACE", "SESSION ID", "STATE", "UPDATED (UTC)", "TITLE"], rows);
}

function renderActiveTable(workspaces: ListedWorkspace[]): string {
  const rows = workspaces.flatMap(({ cwd, sessions, empty }) => [
    ...sessions.map(({ id, state, title }) => [cwd, id, state, title]),
    ...empty.map(({ id }) => [cwd, id, "unsaved", null]),
  ]);
  return renderTable(["WORKSPACE", "SESSION ID", "STATE", "TITLE"], rows);
}

function renderHistoryTable(history: HistoryEntry[]): string {
  const rows = history.map(({ cwd, id, mtime, title }) => [cwd, id, formatUpdatedAt(mtime), title]);
  return renderTable(["WORKSPACE", "SESSION ID", "UPDATED (UTC)", "TITLE"], rows);
}

function formatUpdatedAt(mtime: number | null): string | null {
  return mtime === null ? null : new Date(mtime).toJSON();
}

function renderTable(headers: string[], rows: (string | null)[][]): string {
  const table = [
    headers,
    ...rows.map((row) =>
      row.map((value) =>
        (value ?? "-").replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, (character) => {
          const hex = character.charCodeAt(0).toString(16).padStart(4, "0");
          return "\\u" + hex;
        }),
      ),
    ),
  ];
  const lastColumn = headers.length - 1;
  const widths = headers
    .slice(0, lastColumn)
    .map((_, column) =>
      table.reduce((width, row) => Math.max(width, Bun.stringWidth(row[column]!)), 0),
    );
  return table
    .map((row) =>
      row
        .map((cell, column) =>
          column === lastColumn ? cell : cell + " ".repeat(widths[column]! - Bun.stringWidth(cell)),
        )
        .join("  "),
    )
    .join("\n");
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
      if (
        argv[index] === "--cwd" &&
        cwd === undefined &&
        cwdValue !== undefined &&
        isAbsolute(cwdValue)
      ) {
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
  if (argv[0] === "send") {
    if (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help")) return { kind: "help" };
    let index = 1;
    let waitSeconds: number | undefined;
    if (argv[index] === "--wait" && /^[1-9]\d*$/.test(argv[index + 1] ?? "")) {
      waitSeconds = Number(argv[index + 1]);
      index += 2;
    }
    const id = argv[index];
    const textParts = argv.slice(index + 1);
    if (id && SESSION_ID_PATTERN.test(id) && textParts.length > 0) {
      const text = textParts.join(" ");
      if (text.trim() && !text.includes("\0")) {
        const length = [...text].length;
        if (length > MESSAGE_TEXT_MAX_CODE_POINTS)
          throw new Error(
            `Message text is ${length} code points; the limit is ${MESSAGE_TEXT_MAX_CODE_POINTS}`,
          );
        return { kind: "send", id, waitSeconds, text };
      }
    }
  }
  if (argv[0] === "open") {
    const [, mode, flag, file, exactId] = argv;
    if (
      argv.length === 5 &&
      mode === "--detached" &&
      flag === "--expect-file" &&
      file &&
      isAbsolute(file) &&
      file.endsWith(".jsonl") &&
      !file.includes("\0") &&
      exactId &&
      SESSION_ID_PATTERN.test(exactId)
    )
      return { kind: "open-exact", id: exactId, file };
    let index = 1;
    let temporary = false;
    let detached = false;
    for (; index < argv.length; index++) {
      if (argv[index] === "--temporary" && !temporary) temporary = true;
      else if (argv[index] === "--detached" && !detached) detached = true;
      else break;
    }
    const id = argv[index];
    if (argv.length === index + 1 && id && SESSION_ID_PATTERN.test(id))
      return { kind: "open", id, temporary, detached };
  }
  if (argv[0] === "inspect") {
    const id = argv[1];
    if (argv.length === 2 && id && SESSION_ID_PATTERN.test(id)) return { kind: "inspect", id };
    if (id === "--dispatch-ticket") return parseDispatchTicketOperation(argv.slice(2));
    if (
      id === "--management" &&
      argv.length === 3 &&
      isAbsolute(argv[2]!) &&
      !argv[2]!.includes("\0")
    )
      return { kind: "inspect-management", socket: argv[2]! };
    if (
      id === "--dispatch-inventory" &&
      argv.length === 3 &&
      isAbsolute(argv[2]!) &&
      !argv[2]!.includes("\0")
    )
      return { kind: "inspect-dispatch-inventory", socket: argv[2]! };
    if (id === "--create-dispatch-worker") return parseWindowsCreateDispatchWorker(argv.slice(2));
  }
  if (
    argv[0] === "windows-claim-launch" &&
    (argv.length === 3 || argv.length === 4) &&
    UUID.test(argv[1]!)
  ) {
    const command: unknown = JSON.parse(Buffer.from(argv[2]!, "base64").toString("utf8"));
    if (
      !Array.isArray(command) ||
      !isAbsolute(command[0] ?? "") ||
      !command.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    )
      throw new Error("Invalid Windows pi launch command");
    const reload = argv[3] === undefined ? undefined : parseWindowsReloadRoute(argv[3]);
    return { kind: "windows-claim-launch", token: argv[1]!, command, reload };
  }
  if (argv[0] === "worktree") {
    const [, action, encoded] = argv;
    if (argv.length !== 3 || action !== "snapshot" || encoded === undefined)
      throw new Error("usage: pi-mux worktree snapshot <JSON>");
    return { kind: "worktree-snapshot", request: parseWorktreeSnapshotRequest(encoded) };
  }
  if (argv[0] === "metadata") {
    const [, first, id, viewFile] = argv;
    if (argv.length === 2 && first && SESSION_ID_PATTERN.test(first))
      return { kind: "metadata", id: first };
    if (
      argv.length === 4 &&
      first === "--view-target" &&
      id &&
      SESSION_ID_PATTERN.test(id) &&
      viewFile &&
      isAbsolute(viewFile) &&
      viewFile.endsWith(".jsonl") &&
      !viewFile.includes("\0")
    )
      return { kind: "metadata", id, viewFile };
  }
  if (argv[0] === "record-view" && argv.length === 3) {
    const id = argv[1];
    if (id && SESSION_ID_PATTERN.test(id)) {
      const receipt: unknown = JSON.parse(argv[2]!);
      if (isViewReceipt(receipt)) return { kind: "record-view", id, receipt };
    }
    throw new Error("Invalid session view receipt");
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
  const listing = parseListingOperation(argv);
  if (listing) return listing;
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
  if (argv[0] === "reload") {
    if (argv.length === 1) return { kind: "reload", id: undefined };
    const id = argv[1];
    if (argv.length === 2 && id && SESSION_ID_PATTERN.test(id)) return { kind: "reload", id };
  }
  if (argv[0] === "restart" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--force")))
    return { kind: "restart", force: argv[1] === "--force" };
  if (argv.length === 1 && argv[0] === "restore") return { kind: "restore" };
  if ((argv.length === 1 || argv.length === 2) && argv[0] === "snapshot")
    return { kind: "snapshot", generation: argv[1] };
  throw new Error(
    "usage: pi-mux [new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request] | open [--temporary] [--detached] <session-id> | open --detached --expect-file <absolute-jsonl-path> <session-id> | inspect <session-id> | metadata <session-id> | state <session-id> <state> --source <JSON> --title <JSON> | state <session-id> --clear --source <JSON> | send [--wait <seconds>] <session-id> <text...> | close [--if-temporary] <session-id> | list [--json] | list --active [--json] | list --saved [--cwd <absolute-cwd>] [--json] | list --displayed [--client-pid <pid>] [--json] | switch <session-id> [--client-pid <pid>] | history [--cwd <absolute-cwd>] [--json] | workspace register|unregister <cwd> | snapshot [server-generation] | restore | reload [<session-id>] | restart [--force]]",
  );
}

function parseListOperation(args: string[]): ListOperation | undefined {
  let scope: ListOperation["scope"] = "all";
  let cwd: string | undefined;
  let clientPid: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json" && !json) {
      json = true;
    } else if (
      scope === "all" &&
      (flag === "--active" || flag === "--saved" || flag === "--displayed")
    ) {
      if (flag === "--active") scope = "active";
      else if (flag === "--saved") scope = "saved";
      else scope = "displayed";
    } else if (flag === "--cwd" && cwd === undefined) {
      const value = args[++index];
      if (!value || !isAbsolute(value)) return;
      cwd = value;
    } else if (flag === "--client-pid" && clientPid === undefined) {
      const value = args[++index];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return;
      clientPid = Number(value);
    } else {
      return;
    }
  }
  if (scope === "displayed" && cwd === undefined) return { kind: "list", scope, clientPid, json };
  if (clientPid !== undefined) return;
  if (scope === "saved") return { kind: "list", scope, cwd, json };
  if (scope !== "displayed" && cwd === undefined) return { kind: "list", scope, json };
}

function parseListingOperation(argv: string[]): Operation | undefined {
  const kind = argv[0];
  if (kind === "list") return parseListOperation(argv.slice(1));
  if (kind !== "history") return;

  const jsonFirst = argv[1] === "--json";
  const jsonLast = argv.at(-1) === "--json";
  const json = jsonFirst || jsonLast;
  const args = jsonFirst ? argv.slice(2) : argv.slice(1, jsonLast ? -1 : undefined);

  if (args.length === 0) return { kind, cwd: undefined, json };
  const [flag, cwd] = args;
  if (args.length === 2 && flag === "--cwd" && cwd && isAbsolute(cwd)) return { kind, cwd, json };
}

function parseStateOperation(argv: string[]): Operation {
  const id = argv[1];
  try {
    if (!id || !SESSION_ID_PATTERN.test(id)) throw new Error("Invalid complete conversation ID");
    const state = argv[2];
    const clear = state === "--clear";
    if (!clear && !isSessionState(state)) throw new Error("Invalid state");
    const options = new Map<string, unknown>();
    for (let index = 3; index < argv.length; index += 2) {
      const key = argv[index]!;
      const value = argv[index + 1];
      if ((key !== "--source" && key !== "--title") || options.has(key) || value === undefined)
        throw new Error("Missing, duplicate, or unexpected state argument");
      options.set(key, JSON.parse(value));
    }
    const hasRequiredOptions =
      options.has("--source") && (clear ? options.size === 1 : options.has("--title"));
    if (!hasRequiredOptions)
      throw new Error("State requires source and title; clear requires only source");
    const source = parseSource(options.get("--source"));
    if (clear) return { kind: "state", id, source, notification: { clear: true } };

    const title = options.get("--title");
    if (title !== null && typeof title !== "string") throw new Error("Invalid title");
    return { kind: "state", id, source, notification: { clear: false, state, title } };
  } catch (error) {
    throw new Error(`state ${id ?? "<missing>"}: ${errorMessage(error)}`);
  }
}

function parseSource(source: unknown): StateSource {
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
    !UUID.test(source.token)
  )
    throw new Error("Invalid source");
  return {
    socket: source.socket,
    serverPid: Number(source.serverPid),
    pane: source.pane,
    pid: Number(source.pid),
    token: source.token,
  };
}

function temporarySessionQuery(session: string): string[] {
  return ["show-environment", "-t", session, "PI_TMUX_TEMPORARY"];
}

async function isTemporarySession(
  config: TmuxConfig,
  session: string,
  id: string,
): Promise<boolean> {
  const result = await tmux(config, temporarySessionQuery(session), true);
  return readTemporarySession(config, session, id, result, "strict");
}

function readTemporarySession(
  config: TmuxConfig,
  session: string,
  id: string,
  result: Awaited<ReturnType<typeof tmux>>,
  mode: "strict" | "allow-missing",
): boolean {
  if (result.exitCode !== 0) {
    if (result.stderr.includes("unknown variable: PI_TMUX_TEMPORARY")) return false;
    if (
      mode === "allow-missing" &&
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
): Promise<{ session: string; panePid: number; file?: string }> {
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
  return { session, panePid: target.panePid, file: target.file };
}

async function deferUnfinishedPublish(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  panePid: number,
): Promise<void> {
  const attemptAt = Date.now();
  const pending = guardedTmuxLine(
    source.pane,
    paneEntityGuard(source.serverPid, source.pane, panePid),
    [
      ["set-option", "-p", "-t", source.pane, "@pi-mux-pending-restart-blocker", "1"],
      ["set-option", "-g", "@pi-mux-restart-veto", randomUUID()],
      [
        "set-option",
        "-p",
        "-t",
        source.pane,
        "@pi_session_state_pending",
        JSON.stringify({ version: 1, sessionId: id, attemptAt }),
      ],
    ],
  );
  await tmux(config, ["source-file", "-"], false, `${pending}\n`);
}

async function clearPendingPublication(
  config: TmuxConfig,
  source: StateSource,
  panePid: number,
): Promise<void> {
  const clear = guardedTmuxLine(
    source.pane,
    paneEntityGuard(source.serverPid, source.pane, panePid),
    [["set-option", "-pu", "-t", source.pane, "@pi_session_state_pending"]],
  );
  await tmux(config, ["source-file", "-"], false, `${clear}\n`);
}

async function notifyWindowsState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<number> {
  if (source.socket !== config.socket)
    throw new Error("Source socket does not match the dedicated socket");
  const management = windowsManagement(config);
  const observe = () => verifyWindowsStateSource(management, id, source);
  const initial = await observe();
  const lastRun =
    !notification.clear && notification.state === "waiting-user" && initial.file
      ? readSessionLastRun(initial.file, id)
      : undefined;
  const target = lastRun ? await observe() : initial;
  if (
    target.audit.basis.instance !== initial.audit.basis.instance ||
    target.peer.identity !== initial.peer.identity ||
    target.panePid !== initial.panePid ||
    target.processes.some(
      (process, index) => process.creationTime !== initial.processes[index]?.creationTime,
    )
  )
    throw new Error("Source Pi process changed during state verification");

  const ownState = ["@pi-mux-state-source", windowsStateJson({ id, ...source })] as const;
  const mutate = (
    mutations: Parameters<typeof mutateWindowsPeerPane>[4]["mutations"],
    owner?: typeof ownState,
    expected: Parameters<typeof mutateWindowsPeerPane>[4]["expected"] = [],
  ) =>
    mutateWindowsPeerPane(management.scope, target.audit, target.peer, source.pane, {
      expected: [
        ["pane_pid", String(target.panePid)],
        ["@pi-tmux-session", target.encoded],
        ["@pi-mux-launch", target.launch],
        ...expected,
      ],
      owner,
      mutations,
      processes: target.processes,
    });

  if (notification.clear) {
    await mutate(
      clearStateOptions(source.pane).map((args) => ({ option: args.at(-1)! })),
      ownState,
    );
    return 0;
  }

  await mutate([
    { option: ownState[0], value: ownState[1] },
    {
      option: "@pi_session_state",
      value: windowsStateJson({
        version: 1,
        sessionId: id,
        state: notification.state,
        title: notification.title,
        lastRun: target.file === initial.file ? lastRun : undefined,
      }),
    },
    { option: "@pi-mux-pending-restart-blocker" },
  ]);
  if (notification.state !== "running" || (!target.temporary && !target.audit.startup)) return 0;

  const mutateOwned = async (
    mutations: Parameters<typeof mutate>[0],
    expected?: Parameters<typeof mutate>[2],
  ) => {
    if ((await mutate(mutations, ownState, expected)) !== "applied")
      throw new Error("Source no longer owns the published session state");
  };
  try {
    return await withLock(
      config,
      async () => {
        if (target.temporary) {
          const current = await observe();
          if (
            current.audit.basis.instance !== target.audit.basis.instance ||
            current.peer.identity !== target.peer.identity ||
            current.panePid !== target.panePid
          )
            throw new Error("Source pane changed before promotion");
          if (current.temporary)
            await mutateOwned([{ unsetTemporary: true }], [["PI_TMUX_TEMPORARY", id]]);
        }
        await management.assertLive(target.audit.basis);
        await snapshotSessions(config, target.audit.basis.instance, "repair");
        await mutateOwned([{ option: "@pi_session_state_pending" }]);
        return 0;
      },
      "try",
    );
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    await mutateOwned([
      { option: "@pi-mux-pending-restart-blocker", value: "1" },
      { option: "@pi-mux-restart-veto", value: randomUUID(), global: true },
      {
        option: "@pi_session_state_pending",
        value: windowsStateJson({ version: 1, sessionId: id, attemptAt: Date.now() }),
      },
    ]);
    console.error(`pi-mux: state ${id}: ${errorMessage(error)}`);
    return 75;
  }
}

function windowsStateJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("$", "\\u0024").replaceAll("\x7f", "\\u007f");
}

async function verifyWindowsStateSource(
  management: WindowsManagement,
  id: string,
  source: StateSource,
) {
  const audit = await management.audit(
    "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@pi-tmux-session}\t#{@pi-mux-launch}\t#{PI_TMUX_TEMPORARY}",
    { requireRestored: false },
  );
  const matches = audit.panes.flatMap(({ peer, rows }) =>
    rows.flatMap((row) => {
      const fields = row.split("\t");
      const [pane, rawPid, dead, encoded, launch, temporary] = fields;
      if (fields.length !== 6 || !/^%\d+$/.test(pane ?? "") || (dead !== "0" && dead !== "1"))
        throw new Error(`Invalid psmux pane inventory for state: ${peer.name}`);
      if (dead === "1" || !encoded) return [];
      if (!/^[1-9]\d*$/.test(rawPid ?? ""))
        throw new Error(`Invalid live psmux pane PID for state: ${peer.name}`);
      const metadata: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (!isRecord(metadata)) throw new Error(`Invalid Pi metadata in pane ${pane}`);
      if (metadata.id !== id) return [];
      return [
        { peer, pane, panePid: Number(rawPid), encoded, launch: launch!, temporary, metadata },
      ];
    }),
  );
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match ||
    match.peer.identity.split(":")[0] !== String(source.serverPid) ||
    match.pane !== source.pane ||
    match.metadata.pid !== match.panePid ||
    (match.metadata.processPid ?? match.panePid) !== source.pid ||
    match.metadata.token !== source.token ||
    (match.launch && !matchesLaunch(match.launch, id, match.panePid, source.token)) ||
    (match.metadata.startup !== undefined &&
      match.metadata.startup !== "accepted" &&
      match.metadata.startup !== "ready")
  )
    throw new Error("Source Pi process does not match the conversation and pane");
  const processes = [...new Set([match.panePid, source.pid])].map((pid) => {
    const process = inspectWindowsProcess(pid);
    if (process.state !== "live") throw new Error(`Cannot verify source Windows process ${pid}`);
    return process.identity;
  });
  const { file } = match.metadata;
  return {
    ...match,
    audit,
    processes,
    temporary: match.temporary === id,
    file: typeof file === "string" && isAbsolute(file) ? file : undefined,
  };
}

async function notifyState(
  config: TmuxConfig,
  id: string,
  source: StateSource,
  notification: StateNotification,
): Promise<number> {
  if (platform.windows) return await notifyWindowsState(config, id, source, notification);
  const { session, panePid, file } = await verifyStateSource(config, id, source);
  const owner = JSON.stringify({ id, ...source });
  if (notification.clear) {
    const currentOwner = await tmux(config, [
      "show-options",
      "-pqv",
      "-t",
      source.pane,
      "@pi-mux-state-source",
    ]);
    if (currentOwner.stdout.trimEnd() !== owner) return 0;
  }
  const lastRun =
    !notification.clear && notification.state === "waiting-user" && file
      ? readSessionLastRun(file, id)
      : undefined;
  await runGuardedStateCommands(config, source, {
    id,
    owner,
    notification,
    panePid,
    file,
    lastRun,
  });
  if (notification.clear || notification.state !== "running") return 0;
  const needsPromotion = await isTemporarySession(config, session, id);
  const needsRepair = Boolean(await serverOption(config, "@pi-mux-generation"));
  if (!needsPromotion && !needsRepair) return 0;
  try {
    return await withLock(
      config,
      async () => {
        if (needsPromotion) await promoteSession(config, session, id);
        if (needsRepair) await snapshotSessions(config, undefined, "repair");
        await clearPendingPublication(config, source, panePid);
        return 0;
      },
      "try",
    );
  } catch (error) {
    if (!(error instanceof LockBusyError)) throw error;
    try {
      await deferUnfinishedPublish(config, id, source, panePid);
    } catch (deferredError) {
      console.error(`pi-mux: state ${id}: ${errorMessage(deferredError)}`);
    }
    console.error(`pi-mux: state ${id}: ${errorMessage(error)}`);
    return 75;
  }
}

function clearStateOptions(pane: string): string[][] {
  return [
    "@pi_session_state",
    "@pi-mux-state-source",
    "@pi-mux-pending-restart-blocker",
    "@pi_session_state_pending",
  ].map((option) => ["set-option", "-pu", "-t", pane, option]);
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

function waitingUserStopChain(panes: string[], action: string, waitMarker: string): string {
  const wait = tmuxArguments(["display-message", "-p", waitMarker]);
  let branch = action;
  for (const pane of panes) {
    branch = tmuxArguments([
      "if-shell",
      "-t",
      pane,
      "-F",
      `#{&&:#{==:#{pane_id},${pane}},#{m:*"state":"waiting-user"*,#{@pi_session_state}}}`,
      branch,
      wait,
    ]);
  }
  return branch;
}
async function verifyStateTarget(
  config: TmuxConfig,
  id: string,
  source: StateSource,
): Promise<{ pane: string; pid: number; panePid: number; file?: string }> {
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
        file?: unknown;
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
      const file =
        typeof metadata.file === "string" && isAbsolute(metadata.file) ? metadata.file : undefined;
      return [{ pane, pid, panePid: Number(panePid), token, file }];
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
    panePid: number;
    file?: string;
    lastRun?: LastRun;
  },
): Promise<void> {
  const verified = await verifyStateSource(config, plan.id, source);
  const entity = paneEntityGuard(source.serverPid, source.pane, plan.panePid);
  const pane = source.pane;
  const lines: string[] = [];
  if (plan.notification.clear) {
    lines.push(
      guardedTmuxLine(
        pane,
        entity,
        [...clearStateOptions(pane), ["display-message", "-p", "PI_MUX_STATE_WRITTEN"]],
        "PI_MUX_SOURCE_UNVERIFIED",
      ),
    );
  } else {
    const stateValue = JSON.stringify({
      version: 1,
      sessionId: plan.id,
      state: plan.notification.state,
      title: plan.notification.title,
      lastRun: verified.file === plan.file ? plan.lastRun : undefined,
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

function resolveAgentDirectory(): string {
  return expandPath(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent");
}

function tmuxConfiguration() {
  const directory = join(platform.runtimeStateRoot(), "pi-tmux");
  const agentDir = resolveAgentDirectory();
  const extension = join(agentDir, "extensions", "pi-mux-bridge", "index.ts");
  const tmuxConfig = join(homedir(), ".config", platform.windows ? "psmux" : "tmux", "pi.conf");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !PARENT_ENV_KEYS.has(entry[0]) &&
        (!platform.windows ||
          (!PSMUX_ROUTING.has(entry[0]) && entry[0].toUpperCase() !== PI_HARDWARE_CURSOR_ENV)),
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

type ReleaseLock = () => Promise<void>;

function lockAddress(config: TmuxConfig, scope = ""): string {
  const key = createHash("sha256")
    .update(realpathSync(config.stateDirectory))
    .update(scope)
    .digest("hex");
  return platform.lockAddress(key);
}

async function tryAcquireLock(address: string): Promise<ReleaseLock | undefined> {
  const lock = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(address, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    throw error;
  }
  return () =>
    new Promise<void>((resolve, reject) => {
      lock.close((error) => (error ? reject(error) : resolve()));
    });
}

function canonicalSocketPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parent = dirname(path);
  let link: string;
  try {
    link = readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(canonicalSocketPath(parent), basename(path));
  }
  return canonicalSocketPath(resolve(canonicalSocketPath(parent), link));
}

async function withLock<T>(
  config: TmuxConfig,
  action: () => Promise<T>,
  mode: "wait" | "try" = "wait",
): Promise<T> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  if (platform.windows) {
    const statePath = canonicalSocketPath(config.stateDirectory).toLowerCase();
    return await withLockKey(windowsManagement(config).lockResource, deadline, mode, () =>
      withLockKey(statePath, deadline, mode, action),
    );
  }
  const statePath = realpathSync(config.stateDirectory);
  const socketPath = canonicalSocketPath(config.socket);
  return await withLockKey(`socket:${socketPath}`, deadline, mode, () =>
    withLockKey(statePath, deadline, mode, action),
  );
}

async function withLockKey<T>(
  resource: string,
  deadline: number,
  mode: "wait" | "try",
  action: () => Promise<T>,
): Promise<T> {
  const key = createHash("sha256").update(resource).digest("hex");
  const address = platform.lockAddress(key);
  while (Date.now() < deadline) {
    const release = await tryAcquireLock(address);
    if (!release) {
      if (mode === "try") throw new LockBusyError("Another pi-mux operation holds the lock");
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      await release();
    }
  }
  throw new Error("Timed out waiting for another pi-mux operation");
}

function windowsManagement(config: TmuxConfig): WindowsManagement {
  return new WindowsManagement({ ...config, query: (argv) => tmux(config, argv, true) });
}

function windowsClaimLock(management: WindowsManagement) {
  return <T>(action: () => Promise<T>) =>
    withLockKey(management.claimLockResource, Date.now() + STARTUP_TIMEOUT_MS, "wait", action);
}

async function claimWindowsLaunch(token: string, command: string[]): Promise<number> {
  const config = tmuxConfiguration();
  const management = windowsManagement(config);
  const route = process.env.PSMUX_TARGET_SESSION;
  const pane = process.env.TMUX_PANE;
  const [socket, port, index] = (process.env.TMUX ?? "").split(",");
  const localAlias = /^\/tmp\/psmux-\d+\/([A-Za-z0-9_.-]+)$/.exec(socket ?? "")?.[1];
  const intoNamespace =
    socket === config.socket ||
    (localAlias !== undefined &&
      localAlias === management.scope.namespace &&
      win32.basename(config.socket) === localAlias);
  if (
    !intoNamespace ||
    !/^[1-9]\d{0,4}$/.test(port ?? "") ||
    Number(port) > 65535 ||
    !/^\d+$/.test(index ?? "") ||
    !/^%\d+$/.test(pane ?? "") ||
    process.env[WINDOWS_RIGHT_ENV] !== token ||
    !route
  )
    throw new Error("Cannot identify a Windows pi launch pane");
  const prefix = `${management.scope.namespace}__`;
  if (!route.startsWith(prefix)) throw new Error("Invalid Windows pi launch pane scope");
  const name = route.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid Windows pi launch pane name");
  const routed = {
    ...config,
    env: { ...config.env, TMUX: process.env.TMUX!, PSMUX_TARGET_SESSION: route },
  };
  const identity = await tmux(routed, [
    "display-message",
    "-p",
    "-t",
    pane!,
    `#{session_name}\t#{pane_id}\t#{pane_pid}\t#{${WINDOWS_RIGHT_ENV}}`,
  ]);
  const [sessionName, paneId, panePid, paneToken] = identity.stdout.trimEnd().split("\t");
  if (
    sessionName !== name ||
    paneId !== pane ||
    paneToken !== token ||
    !/^[1-9]\d*$/.test(panePid ?? "")
  )
    throw new Error("Windows pi launch pane identity changed");
  const prepare = async () => {
    const launchToken = process.env.PI_TMUX_LAUNCH_TOKEN;
    const id = process.env.PI_TMUX_SESSION_ID;
    if (id && launchToken)
      await tmux(routed, [
        "set-option",
        "-p",
        "-t",
        pane!,
        "@pi-mux-launch",
        JSON.stringify({ id, pid: Number(panePid), token: launchToken }),
      ]);
    await tmux(routed, ["set-option", "-p", "-t", pane!, WINDOWS_RIGHT_OPTION, token]);
  };
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const started = await rights.claimAndStart(
    token,
    randomUUID(),
    () => {
      const env = { ...process.env };
      configureWindowsPiEnvironment(env, `${config.socket},${port},${index}`);
      try {
        return Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } catch (error) {
        if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw new SpawnDidNotStartError(errorMessage(error), { cause: error });
        throw error;
      }
    },
    prepare,
  );
  return started ? await started.started.exited : 1;
}

function configureWindowsPiEnvironment(env: NodeJS.ProcessEnv, tmux: string): void {
  for (const key of Object.keys(env))
    if (key.toUpperCase() === PI_HARDWARE_CURSOR_ENV) delete env[key];
  env[PI_HARDWARE_CURSOR_ENV] = "1";
  delete env[WINDOWS_RIGHT_ENV];
  env.TMUX = tmux;
}

type WindowsLaunch = {
  keys: string[];
  basis: WindowsManagementBasis;
  name: string;
  cwd: string;
  ownerId?: string;
  environment: Record<string, string>;
  command: string[];
  requireRestored?: boolean;
};

async function startWindowsLaunch(config: TmuxConfig, action: WindowsLaunch): Promise<string> {
  const { basis, keys, cwd, name, environment, command, ownerId, requireRestored = true } = action;
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const right = await rights.reserveAfterLifecycleAudit(keys, basis, { requireRestored });
  if (right.state !== "reserved") throw new Error("A competing Windows pi launch is still running");
  const { token } = right;
  try {
    const env: Record<string, string> = { ...environment, [WINDOWS_RIGHT_ENV]: token };
    const unset = [
      ...new Set([
        ...(await excludedGlobalEnvironment(config, env)).filter((key) => !PSMUX_ROUTING.has(key)),
        ...[...PARENT_ENV_KEYS].filter(
          (key) => !GENERATED_ENV_KEYS.has(key) && !Object.hasOwn(env, key),
        ),
        ...(env.PI_CODING_AGENT_SESSION_DIR === undefined ? ["PI_CODING_AGENT_SESSION_DIR"] : []),
      ]),
    ];
    const invocation = compiledEntry()
      ? [process.execPath]
      : [process.execPath, fileURLToPath(import.meta.url)];
    const payload = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
    const launch = platform.newSessionLaunch(
      [...invocation, "windows-claim-launch", token, payload],
      env,
      unset,
    );
    await tmux(config, [
      "new-session",
      "-d",
      "-s",
      name,
      "-n",
      "pi",
      "-c",
      cwd.replaceAll("#", "##"),
      "-x",
      String(process.stdout.columns || 80),
      "-y",
      String(process.stdout.rows || 24),
      ...launch.environmentArgs,
      "--",
      ...platform.tmuxPaneCommand(launch.paneCommand),
    ]);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await rights.status(token);
      if (status.state === "live" && "receipt" in status) {
        const audit = await management.audit(
          `#{session_id}\t#{@pi-mux-windows-start-right}\t#{pane_dead}`,
          { requireRestored },
        );
        const launched = audit.panes.find(({ peer }) => peer.name === name);
        const target = launched?.rows
          .map((row) => row.split("\t"))
          .filter(([, recorded, dead]) => recorded === token && dead === "0");
        if (!target || target.length !== 1 || !/^\$\d+$/.test(target[0]?.[0] ?? ""))
          throw new Error("Cannot confirm the Windows pi launch pane");
        await management.assertLive(basis);
        await rights.complete(token, status.receipt, ownerId);
        if (launch.transportKey)
          await tmux(config, ["set-environment", "-u", "-t", `=${name}`, launch.transportKey]);
        return target[0]![0]!;
      }
      if (status.state === "missing" || status.state === "ended" || status.state === "unknown")
        throw new Error("The Windows pi launch did not remain active");
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Timed out confirming the Windows pi launch");
  } finally {
    await rights.cancelUnclaimed(token);
  }
}

function parseWindowsCreateDispatchWorker(args: string[]): WindowsCreateDispatchWorker {
  const [socket, generation, name, project, token, cwd, powershell, command] = args;
  if (
    args.length !== 8 ||
    !socket ||
    !generation ||
    !/^[0-9a-f]{16}$/.test(generation) ||
    project === undefined ||
    [".", ".."].includes(project) ||
    /[\\/\0\t\r\n]/.test(project) ||
    name !== `ticket_dispatch_${project ? Buffer.from(project).toString("hex") : "all"}` ||
    !token ||
    !UUID.test(token) ||
    !cwd ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !powershell ||
    !command ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(command)
  )
    throw new Error("Invalid Windows dispatcher worker arguments");
  return {
    kind: "inspect-create-dispatch-worker",
    socket,
    generation,
    name,
    project,
    token,
    cwd,
    powershell,
    command,
  };
}

async function createWindowsDispatchWorker(
  config: TmuxConfig,
  worker: WindowsCreateDispatchWorker,
): Promise<void> {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (win32.normalize(worker.powershell).toLowerCase() !== powershell.toLowerCase())
    throw new Error("Unexpected Windows dispatcher worker shell");
  const cwd = realpathSync(worker.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("Invalid Windows dispatcher workspace");
  const management = windowsManagement(config);
  const audit = await management.audit("#{session_id}");
  if (audit.basis.instance !== worker.generation)
    throw new Error("Windows pi-mux management changed before dispatcher creation");
  if (audit.panes.some(({ peer }) => peer.name === worker.name))
    throw new Error(`Dispatcher session already exists: ${worker.name}`);
  await tmux(config, [
    "new-session",
    "-d",
    "-s",
    worker.name,
    "-c",
    cwd.replaceAll("#", "##"),
    "-e",
    `TICKET_DISPATCH_WORKER_TOKEN=${worker.token}`,
    "-e",
    "TICKET_DISPATCH_ROLE=dispatcher",
    "-e",
    `TICKET_DISPATCH_PROJECT=${worker.project}`,
    "--",
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    worker.command,
  ]);
  await management.assertLive(audit.basis);
}
async function selectWindowsLaunchPanes<
  T extends {
    token: string | undefined;
    paneToken: string | undefined;
    hasPiMetadata?: boolean;
  },
>(name: string, rows: T[], rights: WindowsLaunchRights) {
  const groups = new Map<string, T[]>();
  const selected: { row: T; status?: Extract<WindowsLaunchStatus, { receipt: unknown }> }[] = [];
  for (const row of rows) {
    const { token, paneToken } = row;
    if (paneToken && paneToken !== token)
      throw new Error(`Conflicting Windows pi launch markers in ${name}`);
    if (!token) {
      selected.push({ row });
      continue;
    }
    if (!UUID.test(token)) throw new Error(`Invalid Windows pi launch token in ${name}`);
    const group = groups.get(token) ?? [];
    group.push(row);
    groups.set(token, group);
  }
  for (const [token, group] of groups) {
    const status = await rights.status(token);
    if (status.state === "missing" || status.state === "ended" || status.state === "reserved") {
      if (
        group.some(({ hasPiMetadata }) => hasPiMetadata) ||
        (status.state === "missing" && group.some(({ paneToken }) => paneToken))
      )
        throw new Error(`Windows pi pane has no verifiable live launch in ${name}`);
      continue;
    }
    const marked = group.filter(({ paneToken }) => paneToken === token);
    if (
      status.state !== "live" ||
      !("receipt" in status) ||
      marked.length !== 1 ||
      group.some(({ paneToken, hasPiMetadata }) => !paneToken && hasPiMetadata)
    )
      throw new Error(`Cannot confirm the Windows pi launch outcome in ${name}`);
    selected.push({ row: marked[0]!, status });
  }
  return selected;
}

async function readWindowsDispatchInventory(config: TmuxConfig) {
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const unaccounted = new Set(await rights.fenceForDispatchInventory());
  const audit = await management.audit(
    `#{TICKET_DISPATCH_ROLE}\t#{TICKET_DISPATCH_PROJECT}\t#{TICKET_DISPATCH_ID}\t#{session_created}\t#{pane_dead}\t#{${WINDOWS_RIGHT_ENV}}\t#{${WINDOWS_RIGHT_OPTION}}`,
  );
  const sessions: { name: string; project: string; ticketId: string; created: number }[] = [];
  for (const { peer, rows } of audit.panes) {
    const parsed = rows.flatMap((row) => {
      const parts = row.split("\t");
      if (parts.length !== 7 || !["0", "1"].includes(parts[4]!))
        throw new Error(`Invalid Windows ticket dispatch pane in ${peer.name}`);
      const [role, project, ticketId, time, dead, token, paneToken] = parts;
      return role === "pi" && dead === "0" ? [{ project, ticketId, time, token, paneToken }] : [];
    });
    let entry: (typeof sessions)[number] | undefined;
    for (const {
      row: { project, ticketId, time, token },
      status,
    } of await selectWindowsLaunchPanes(peer.name, parsed, rights)) {
      const created = Number(time);
      if (
        !project ||
        [".", ".."].includes(project) ||
        /[\\/\0\r\n]/.test(project) ||
        !ticketId ||
        ticketId.length > DISPATCH_TICKET_ID_MAX_LENGTH ||
        !DISPATCH_TICKET_ID_PATTERN.test(ticketId) ||
        !/^[1-9]\d*$/.test(time ?? "") ||
        !Number.isSafeInteger(created)
      )
        throw new Error(`Invalid Windows ticket dispatch metadata in ${peer.name}`);
      if (token && status) {
        if (!unaccounted.delete(token))
          throw new Error(`Unexpected or duplicate Windows dispatch launch in ${peer.name}`);
        await rights.completeDispatched(
          token,
          status.receipt,
          audit.basis,
          ticketLaunchKey(project, ticketId),
        );
      }
      const candidate = { name: peer.name, project, ticketId, created };
      if (entry && JSON.stringify(entry) !== JSON.stringify(candidate))
        throw new Error(`Ambiguous Windows ticket dispatch metadata in ${peer.name}`);
      entry = candidate;
    }
    if (entry) sessions.push(entry);
  }
  for (const token of unaccounted) {
    if ((await rights.status(token)).state !== "ended")
      throw new Error("Cannot locate a live Windows ticket launch in the pane inventory");
  }
  await management.assertLive(audit.basis);
  return sessions;
}

async function inspectWindowsBeforeOpen(
  config: TmuxConfig,
  id: string,
  expected?: WindowsManagementBasis,
) {
  const basis = expected ?? (await windowsManagement(config).currentBasis());
  if (!basis) return { running: undefined, managed: undefined, basis: undefined };
  return await inspectWindowsRunningSession(config, id, false, basis);
}

async function inspectWindowsRunningSession(
  config: TmuxConfig,
  id: string,
  requireRestored = true,
  expected?: WindowsManagementBasis,
) {
  const management = windowsManagement(config);
  const audit = await management.audit(
    `${PANE_FORMAT}\t#{PI_TMUX_SESSION_ID}\t#{TICKET_DISPATCH_ROLE}\t#{${WINDOWS_RIGHT_ENV}}\t#{@pi-mux-launch}\t#{session_path}\t#{${WINDOWS_RIGHT_OPTION}}\t#{TICKET_DISPATCH_PROJECT}\t#{TICKET_DISPATCH_ID}`,
    { requireRestored },
  );
  if (expected && !launchBasisStillLive(expected, audit.basis))
    throw new Error("The dedicated psmux management generation changed during inspection");
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const allPanes: string[] = [];
  const candidates = new Map<string, ManagedSession>();
  const seenTokens = new Set<string>();
  for (const { peer, rows } of audit.panes) {
    const live = rows.flatMap((row) => {
      const fields = row.split("\t");
      if (fields.length !== 16) throw new Error("Invalid Windows pi pane inventory");
      const [pane, session, name, metadata, pid, dead, , , , , token, launch, , paneToken] = fields;
      if (!pane || !session || !name || !pid || !["0", "1"].includes(dead!))
        throw new Error("Invalid Windows pi pane identity");
      return dead === "0"
        ? [
            {
              fields,
              pane,
              session,
              name,
              pid,
              token,
              paneToken,
              hasPiMetadata: !!(metadata || launch),
            },
          ]
        : [];
    });
    for (const {
      row: { fields, session, name, pid, token },
      status,
    } of await selectWindowsLaunchPanes(peer.name, live, rights)) {
      const [, , , metadata, , , , , managedId, role, , launch, cwd, , project, ticketId] = fields;
      if (metadata) allPanes.push(fields.slice(0, 8).join("\t"));
      if (managedId && (!SESSION_ID_PATTERN.test(managedId) || !isAbsolute(cwd ?? "")))
        throw new Error("Invalid Windows managed conversation or workspace");
      if (token && status) {
        if (seenTokens.has(token)) throw new Error(`Duplicate Windows pi launch token in ${name}`);
        seenTokens.add(token);
        if (role === "pi") {
          if (!project || !ticketId)
            throw new Error(`Cannot identify a Windows ticket dispatch in ${name}`);
          if (!status.completed)
            await rights.completeDispatched(
              token,
              status.receipt,
              audit.basis,
              ticketLaunchKey(project, ticketId),
            );
          if (!metadata) continue;
        }
        if (metadata) {
          const published = parseLivePaneRows(fields.slice(0, 8).join("\t"), "list");
          if (
            published.length !== 1 ||
            published[0]!.pid !== status.receipt.child.pid ||
            (managedId !== undefined && managedId !== "" && published[0]!.id !== managedId)
          )
            throw new Error(
              `Published metadata does not correspond to the Windows launch in ${name}`,
            );
        }
      }
      if (
        !metadata &&
        (role === "pi" ||
          (launch &&
            (!managedId ||
              !matchesLaunch(launch, managedId, Number(pid), launchRecordToken(launch)))))
      )
        throw new Error(`Cannot identify the starting pi in ${name}`);
      if (!metadata && managedId && !launch)
        throw new Error(`Cannot identify the starting managed conversation in ${name}`);
      if (managedId?.toLowerCase() === id.toLowerCase())
        candidates.set(session, { session, id: managedId, cwd: cwd!, temporary: false });
    }
  }
  const running = parseLivePaneRows(allPanes.join("\n"), "list").filter(
    (pane) => pane.id.toLowerCase() === id.toLowerCase(),
  );
  if (
    running.length > 1 ||
    candidates.size > 1 ||
    (running[0] && candidates.size > 0 && !candidates.has(running[0].session))
  )
    throw new Error(`Multiple pi processes are running for session ${id}`);
  const starting = (await rights.inspect([conversationLaunchKey(id)])) === "present";
  await management.assertLive(audit.basis);
  return {
    running: running[0],
    managed: [...candidates.values()][0],
    starting,
    restoring: audit.startup?.restoring.includes(id.toLowerCase()),
    basis: audit.basis,
  };
}

type ServerLifetime = { pid: number; generation: string };

async function serverLifetime(config: TmuxConfig): Promise<ServerLifetime | undefined> {
  if (platform.windows) {
    const basis = await windowsManagement(config).currentBasis();
    if (!basis) return;
    return { pid: Number(basis.witnesses[0]!.split(":")[0]), generation: basis.instance };
  }
  const query = ["display-message", "-p", "#{pid}"];
  const generationOption = "@pi-mux-generation";
  const batch = config.noStart && !platform.windows;
  if (batch) query.push(";", "show-options", "-gqv", generationOption);
  const result = await tmux(config, query, true);
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr)) return undefined;
    throw new Error(`Cannot inspect dedicated server: ${result.stderr.trim()}`);
  }
  const [pidText, ...options] = result.stdout.trimEnd().split("\n");
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid dedicated server PID");
  const generation = batch ? options.join("\n") : await serverOption(config, generationOption);
  return { pid, generation };
}

async function verifyServerLifetime(
  config: TmuxConfig,
  expected: ServerLifetime,
  phase = "restart",
): Promise<void> {
  const current = await serverLifetime(config);
  if (
    !current ||
    (!platform.windows && current.pid !== expected.pid) ||
    current.generation !== expected.generation
  )
    throw new Error(`Dedicated server changed during ${phase}`);
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

const WINDOWS_LIFECYCLE_FORMAT = `${PANE_FORMAT}\t#{PI_TMUX_SESSION_ID}\t#{PI_TMUX_TEMPORARY}\t#{session_path}\t#{@pi-mux-launch}\t#{TICKET_DISPATCH_ROLE}\t#{@pi-mux-windows-start-right}\t#{@pi_session_state}\t#{@pi-mux-state-source}\t#{@pi-mux-pending-restart-blocker}`;

async function auditWindowsLifecycle(management: WindowsManagement, mode = "restart") {
  const audit = await management.audit(WINDOWS_LIFECYCLE_FORMAT, { requireRestored: false });
  if (!audit.startup) throw new Error("Dedicated psmux management has not been initialized");
  const managed: ManagedSession[] = [];
  const ownership: { peer: WindowsLifecyclePeer; session: ManagedSession }[] = [];
  const pids: number[] = [];
  const activeIds = new Set<string>();
  const entries = audit.panes.flatMap(({ peer, rows }) => {
    let session: ManagedSession | undefined;
    const panes = rows.flatMap((row) => {
      const fields = row.split("\t");
      const [
        paneId,
        sessionId,
        name,
        metadata,
        pid,
        dead,
        ,
        ,
        id,
        temporary,
        cwd,
        launch,
        role,
        right,
        state,
        owner,
        blocker,
      ] = fields;
      if (
        fields.length !== 17 ||
        !/^%\d+$/.test(paneId ?? "") ||
        !sessionId ||
        name !== peer.name ||
        !["0", "1"].includes(dead ?? "") ||
        (id && (!SESSION_ID_PATTERN.test(id) || !isAbsolute(cwd ?? ""))) ||
        (temporary && temporary !== id)
      )
        throw new Error(`Invalid Windows pi-mux lifecycle inventory in ${peer.name}`);
      if (id) {
        const candidate = { id, cwd: cwd!, session: sessionId, temporary: Boolean(temporary) };
        if (session && JSON.stringify(session) !== JSON.stringify(candidate))
          throw new Error(`Conflicting Windows conversation ownership in ${peer.name}`);
        session = candidate;
      }
      if (dead !== "0") return [];
      if (!/^[1-9]\d*$/.test(pid ?? ""))
        throw new Error(`Cannot identify a live pane process in ${peer.name}`);
      pids.push(Number(pid));
      const [pane] = metadata ? parseLivePaneRows(fields.slice(0, 8).join("\t"), "list") : [];
      if (metadata) {
        if (!pane || (mode !== "reload" && activeIds.has(pane.id.toLowerCase())))
          throw new Error(`Cannot uniquely identify Windows pi in ${peer.name}`);
        activeIds.add(pane.id.toLowerCase());
        pids.push(pane.pid);
      }
      return [
        {
          peer,
          paneId: paneId!,
          panePid: Number(pid),
          pi: pane,
          launch,
          role,
          right,
          state,
          owner,
          blocker,
        },
      ];
    });
    if (session) {
      managed.push(session);
      ownership.push({ peer, session });
    }
    const managedId = session?.id;
    const unresolved = managedId !== undefined && !panes.some(({ pi }) => pi?.id === managedId);
    const dispatchUnpublished =
      panes.some(({ role }) => role === "pi") && !panes.some(({ pi }) => pi);
    return panes.map((pane) => ({ ...pane, unresolved: unresolved || dispatchUnpublished }));
  });
  if (
    mode !== "reload" &&
    new Set(managed.map(({ id }) => id.toLowerCase())).size !== managed.length
  )
    throw new Error("Multiple Windows psmux sessions own the same conversation");
  return { ...audit, startup: audit.startup, managed, ownership, pids, entries };
}

type WindowsLifecycleAudit = Awaited<ReturnType<typeof auditWindowsLifecycle>>;
type WindowsLifecycleEntry = WindowsLifecycleAudit["entries"][number];
type WindowsLifecyclePeer = PsmuxPeer;

function windowsPaneIsWaiting(config: TmuxConfig, entry: WindowsLifecycleEntry): boolean {
  const { pi, peer, paneId, launch, state, owner, blocker } = entry;
  if (!pi || pi.startup === "accepted" || blocker || !owner) return false;
  if (parseSessionState(state, pi.id) !== "waiting-user") return false;
  try {
    const raw: unknown = JSON.parse(owner);
    if (!isRecord(raw) || raw.id !== pi.id) return false;
    const source = parseSource(raw);
    const metadata = JSON.parse(Buffer.from(pi.metadata, "base64").toString("utf8"));
    return (
      source.socket === config.socket &&
      String(source.serverPid) === peer.identity.split(":")[0] &&
      source.pane === paneId &&
      source.pid === pi.pid &&
      source.token === metadata.token &&
      (!launch || matchesLaunch(launch, pi.id, pi.panePid, source.token))
    );
  } catch {
    return false;
  }
}

function windowsRestartIsWaiting(config: TmuxConfig, audit: WindowsLifecycleAudit): boolean {
  return audit.entries.every((entry) =>
    entry.pi
      ? windowsPaneIsWaiting(config, entry)
      : !entry.unresolved && !entry.launch && !entry.right,
  );
}

function windowsStopInventory(audit: WindowsLifecycleAudit): string {
  const identities = audit.entries.map(({ peer, paneId, panePid, pi, launch, right }) =>
    JSON.stringify([peer.identity, paneId, panePid, pi?.id, pi?.pid, pi?.metadata, launch, right]),
  );
  return JSON.stringify([audit.basis.witnesses, identities.sort(), audit.managed]);
}

const WINDOWS_RESTART_RECHECK = Symbol("Windows restart needs a new readiness check");

async function restartWindowsServer(config: Config, force: boolean): Promise<number> {
  const management = windowsManagement(config);
  const original = await withLock(config, () => management.currentBasis());
  while (true) {
    const result = await withLock(config, () =>
      tryRestartWindowsServer(config, management, original, force),
    );
    if (result !== undefined) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function tryRestartWindowsServer(
  config: Config,
  management: WindowsManagement,
  original: WindowsManagementBasis | undefined,
  force: boolean,
): Promise<number | undefined> {
  const previous = readSnapshot(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  if (original) {
    const audit = await auditWindowsLifecycle(management);
    if (!launchBasisStillLive(original, audit.basis))
      throw new Error("Dedicated psmux generation changed during restart");
    if (previous?.generation && previous.generation !== original.instance)
      throw new Error("Snapshot belongs to another psmux generation");
    if (!force && !windowsRestartIsWaiting(config, audit)) return;

    const panes = captureWindowsProcesses(audit.pids);
    const activeLaunches = await rights.fenceForRestart(true);
    const hasUnmatchedLaunch = activeLaunches.some(({ child, token, basis, completed, keys }) => {
      if (
        panes.some(
          ({ pid, creationTime }) => pid === child.pid && creationTime === child.creationTime,
        )
      )
        return false;
      if (!completed || basis.instance !== audit.basis.instance) return true;
      const matchingPanes = audit.entries.filter((entry) => entry.right === token);
      const pi = matchingPanes[0]?.pi;
      return matchingPanes.length !== 1 || !pi || !keys.includes(conversationLaunchKey(pi.id));
    });
    if (!force && (panes.length !== new Set(audit.pids).size || hasUnmatchedLaunch)) return;

    await management.assertLive(audit.basis);
    const excluded = new Set(
      audit.managed.filter(({ temporary }) => temporary).map(({ id }) => id.toLowerCase()),
    );
    const restoring = new Set(audit.startup.restoring);
    const candidates = uniqueCandidates([
      ...(previous?.sessions ?? []).filter(
        ({ id }) => restoring.has(id.toLowerCase()) && !excluded.has(id.toLowerCase()),
      ),
      ...audit.managed.filter(({ temporary }) => !temporary).map(({ id, cwd }) => ({ id, cwd })),
    ]);
    try {
      const peers = await stopWindowsPeers(management.scope, audit, undefined, async () => {
        if (force) {
          const current = await management.currentBasis();
          if (
            current?.instance !== audit.basis.instance ||
            JSON.stringify(current.witnesses) !== JSON.stringify(audit.basis.witnesses)
          )
            throw new Error("Dedicated psmux peers changed before restart stop");
          await management.prepareStartup(
            audit.basis,
            candidates.map(({ id }) => id),
            windowsClaimLock(management),
          );
        } else {
          const final = await auditWindowsLifecycle(management);
          if (!launchBasisStillLive(audit.basis, final.basis))
            throw new Error("Dedicated psmux generation changed before restart stop");
          if (
            windowsStopInventory(final) !== windowsStopInventory(audit) ||
            JSON.stringify(captureWindowsProcesses(final.pids)) !== JSON.stringify(panes) ||
            !windowsRestartIsWaiting(config, final)
          )
            throw WINDOWS_RESTART_RECHECK;
        }
        writeSnapshot(config, {
          version: 1,
          generation: original.instance,
          cwds: previous?.cwds ?? [],
          sessions: candidates,
        });
      });
      await waitForWindowsExit([...panes, ...activeLaunches.map(({ child }) => child), ...peers], {
        timeoutMs: STARTUP_TIMEOUT_MS,
        pollMs: POLL_INTERVAL_MS,
      });
    } catch (error) {
      if (error === WINDOWS_RESTART_RECHECK) return;
      throw error;
    }
  } else {
    if (await management.currentBasis())
      throw new Error("Dedicated psmux generation changed during restart");
    await rights.fenceForRestart(false);
  }
  if (await management.currentBasis())
    throw new Error("Dedicated psmux did not remain stopped during restart");
  prepareDirectory(config.directory);
  return (await startAndRestore(config, true, undefined, "fresh")).failures > 0 ? 2 : 0;
}

async function restartServer(config: Config, force: boolean): Promise<number> {
  if (platform.windows) return await restartWindowsServer(config, force);
  const original = await withLock(config, () => serverLifetime(config));
  while (true) {
    const result = await withLock(config, async () => {
      if (!original) {
        if (await serverLifetime(config))
          throw new Error("Dedicated server changed during restart");
        prepareDirectory(config.directory);
        return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
      }
      await verifyServerLifetime(config, original);
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
      await verifyServerLifetime(config, original);
      if (!force && !(await restartIsWaiting(config))) return undefined;
      const stopScript = [
        tmuxArguments([
          "if-shell",
          "-F",
          `#{==:#{@pi-mux-generation},${original.generation}}`,
          force
            ? tmuxArguments(["kill-server"])
            : tmuxArguments([
                "if-shell",
                "-F",
                "#{==:#{@pi-mux-restart-veto},}",
                waitingUserStopChain(
                  panes.map((pane) => pane.pane),
                  "kill-server",
                  "PI_MUX_STOP_CHECKED",
                ),
                tmuxArguments(["display-message", "-p", "PI_MUX_STOP_CHECKED"]),
              ]),
          tmuxArguments(["display-message", "-p", "PI_MUX_RESTART_SERVER_CHANGED"]),
        ]),
      ].join("\n");
      const stopped = await tmux(config, ["source-file", "-"], false, `${stopScript}\n`);
      if (stopped.stdout.includes("PI_MUX_RESTART_SERVER_CHANGED"))
        throw new Error("Dedicated server changed before restart stop");
      if (stopped.stdout.includes("PI_MUX_STOP_CHECKED")) return undefined;
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
      return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
    });
    if (result !== undefined) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

type ReloadTarget = { session: ManagedSession; pane: Pane };

type ReloadPublication = {
  pane: Pane;
  launchToken: string;
  preserveWarm: boolean;
  deadlineMs: number;
};

type InFlightReload = ReloadPublication & { release: ReleaseLock };
type ReloadProgress = {
  reloaded: Set<string>;
  failed: Set<string>;
  inFlight: Map<string, InFlightReload>;
};

type WindowsReloadRoute = {
  name: string;
  identity: string;
  instance: string;
  pane: string;
  session: string;
  id: string;
  cwd: string;
  launchToken: string;
  launcher: WindowsProcessIdentity;
  inheritedOverrides: [string, string | null][];
};
type WindowsReloadTarget = {
  session: ManagedSession;
  entry: WindowsLifecycleEntry;
  pane: Pane;
};
type WindowsReloadPublication = Omit<ReloadPublication, "deadlineMs"> & {
  route: WindowsReloadRoute;
  right: string;
  deadlineMs: number;
  release: ReleaseLock;
};
type WindowsReloadProgress = Pick<ReloadProgress, "reloaded" | "failed"> & {
  inFlight: Map<string, WindowsReloadPublication>;
};
type WindowsReloadContext = {
  config: Config;
  management: WindowsManagement;
  rights: WindowsLaunchRights;
  original: WindowsManagementBasis;
  progress: WindowsReloadProgress;
};

function parseWindowsReloadRoute(encoded: string): WindowsReloadRoute {
  const route: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (
    !isRecord(route) ||
    typeof route.name !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(route.name) ||
    typeof route.identity !== "string" ||
    !/^[1-9]\d*:[1-9]\d*$/.test(route.identity) ||
    typeof route.instance !== "string" ||
    !/^[0-9a-f]{16}$/.test(route.instance) ||
    typeof route.pane !== "string" ||
    !/^%\d+$/.test(route.pane) ||
    typeof route.session !== "string" ||
    !/^\$\d+$/.test(route.session) ||
    typeof route.id !== "string" ||
    !SESSION_ID_PATTERN.test(route.id) ||
    typeof route.cwd !== "string" ||
    !isAbsolute(route.cwd) ||
    route.cwd.includes("\0") ||
    typeof route.launchToken !== "string" ||
    !UUID.test(route.launchToken) ||
    !isWindowsProcessIdentity(route.launcher) ||
    !Array.isArray(route.inheritedOverrides) ||
    !route.inheritedOverrides.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        /^[^=\0\r\n]+$/.test(entry[0]) &&
        !PSMUX_ROUTING.has(entry[0].toUpperCase()) &&
        (entry[1] === null || (typeof entry[1] === "string" && !entry[1].includes("\0"))),
    )
  )
    throw new Error("Invalid Windows reload launch route");
  return route as WindowsReloadRoute;
}

function findWindowsReloadPeer(
  observation: WindowsLifecycleAudit | Awaited<ReturnType<WindowsManagement["audit"]>>,
  route: WindowsReloadRoute,
): WindowsLifecyclePeer | undefined {
  if (observation.basis.instance !== route.instance)
    throw new Error("Dedicated psmux generation changed during reload");
  return observation.panes.find(
    ({ peer }) => peer.name === route.name && peer.identity === route.identity,
  )?.peer;
}

async function claimWindowsReload(
  token: string,
  command: string[],
  route: WindowsReloadRoute,
): Promise<number> {
  const config = tmuxConfiguration();
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const destination = `${management.scope.namespace}__${route.name}`;
  const [, port, index] = (process.env.TMUX ?? "").split(",");
  if (
    process.env.PSMUX_TARGET_SESSION !== destination ||
    process.env.TMUX_PANE !== route.pane ||
    process.env[WINDOWS_RIGHT_ENV] !== token ||
    !/^\d+$/.test(index ?? "")
  )
    throw new Error("Windows reload wrapper did not start in its assigned pane");
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await rights.status(token);
    if (status.state === "reserved") {
      const started = await rights.claimAndStart(
        token,
        randomUUID(),
        () => {
          const env = { ...process.env };
          for (const [key, value] of route.inheritedOverrides) {
            for (const inherited of Object.keys(env))
              if (inherited.toUpperCase() === key.toUpperCase()) delete env[inherited];
            if (value !== null) env[key] = value;
          }
          configureWindowsPiEnvironment(env, `${config.socket},${port},${index}`);
          if (observeWindowsIdentity(route.launcher, inspectWindowsProcess) !== "present")
            throw new SpawnDidNotStartError("Windows reload launcher exited before the claim");
          try {
            return Bun.spawn(command, {
              cwd: route.cwd,
              env,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
          } catch (error) {
            if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
              throw new SpawnDidNotStartError(errorMessage(error), { cause: error });
            throw error;
          }
        },
        async () => {
          const audit = await management.audit("#{pane_id}");
          const peer = findWindowsReloadPeer(audit, route);
          if (!peer || String(peer.port) !== port) throw new Error("Windows reload peer changed");
          const expected = await readWindowsPeerPaneFields(
            management.scope,
            audit,
            peer,
            route.pane,
            [
              "session_id",
              "pane_pid",
              "pane_dead",
              "PI_TMUX_SESSION_ID",
              "session_path",
              "PI_TMUX_LAUNCH_TOKEN",
              WINDOWS_RIGHT_ENV,
              "@pi-tmux-session",
            ],
          );
          if (
            JSON.stringify(expected) !==
            JSON.stringify([
              route.session,
              String(process.pid),
              "0",
              route.id,
              route.cwd,
              route.launchToken,
              token,
              "",
            ])
          )
            throw new Error("Cannot verify the new Windows reload pane");
          await runWindowsPeerPaneCommands(management.scope, audit, peer, route.pane, [
            [
              "set-option",
              "-p",
              "-t",
              route.pane,
              "@pi-mux-launch",
              JSON.stringify({ id: route.id, pid: process.pid, token: route.launchToken }),
            ],
            ["set-option", "-p", "-t", route.pane, WINDOWS_RIGHT_OPTION, token],
          ]);
        },
      );
      return started ? await started.started.exited : 1;
    }
    if (
      status.state !== "missing" ||
      observeWindowsIdentity(route.launcher, inspectWindowsProcess) !== "present"
    )
      return 1;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Windows reload launch was not permitted");
}

async function reloadWindowsPanes(config: Config, onlyId?: string): Promise<number> {
  const management = windowsManagement(config);
  const rights = management.createLaunchRights(windowsClaimLock(management));
  const initial = await withLock(config, async () => {
    const original = await management.currentBasis();
    if (!original) {
      if (onlyId !== undefined)
        throw new Error(`Cannot reload session ${onlyId}: the dedicated server is not running`);
      await rights.fenceForRestart(false);
      if (await management.currentBasis())
        throw new Error("Dedicated psmux generation changed during reload");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true, undefined, "fresh")).failures > 0 ? 2 : 0;
    }
    const snapshot = readSnapshot(config);
    const audit = await auditWindowsLifecycle(management, "reload");
    if (!launchBasisStillLive(original, audit.basis) || !audit.startup.restored)
      throw new Error("Cannot confirm a restored psmux generation for reload");
    if (onlyId && !audit.managed.some(({ id }) => id === onlyId)) {
      if (snapshot?.sessions.some(({ id }) => id === onlyId) || (await findSaved(config, onlyId)))
        throw new Error(`The conversation is not running: ${onlyId}`);
      throw new Error(`Session not found (use the complete ID): ${onlyId}`);
    }
    const invocation = compiledEntry()
      ? [process.execPath]
      : [process.execPath, fileURLToPath(import.meta.url)];
    const hookCommand = platform.hookCommand([...invocation, "snapshot", original.instance], {
      PI_CODING_AGENT_DIR: config.agentDir,
    });
    for (const { peer } of audit.panes)
      await configureWindowsPeer(management.scope, audit, {
        configFile: config.tmuxConfig,
        hookCommand,
        peerName: peer.name,
      });
    return original;
  });
  if (typeof initial === "number") return initial;

  const progress: WindowsReloadProgress = {
    reloaded: new Set(),
    failed: new Set(),
    inFlight: new Map(),
  };
  const context = { config, management, original: initial, rights, progress };
  let schedulingFailure: { cause: unknown } | undefined;
  try {
    while (true) {
      const step = schedulingFailure
        ? "done"
        : await withLock(config, () => startNextWindowsReload(context, onlyId)).catch(
            (cause: unknown) => {
              schedulingFailure = { cause };
              return "done" as const;
            },
          );
      await confirmWindowsReloadPublications(context);
      if (step === "done" && progress.inFlight.size === 0) {
        if (schedulingFailure) throw schedulingFailure.cause;
        return progress.failed.size ? 2 : 0;
      }
      if (step !== "started") await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await Promise.all([...progress.inFlight.values()].map(({ release }) => release()));
  }
}

async function startNextWindowsReload(
  context: WindowsReloadContext,
  onlyId?: string,
): Promise<"started" | "wait" | "done"> {
  const { management, original, progress } = context;
  const audit = await auditWindowsLifecycle(management, "reload");
  if (!launchBasisStillLive(original, audit.basis) || !audit.startup.restored)
    throw new Error("Dedicated psmux generation changed during reload");

  const targets = audit.ownership.filter(
    ({ session: { id } }) =>
      (!onlyId || id === onlyId) &&
      !progress.reloaded.has(id) &&
      !progress.failed.has(id) &&
      !progress.inFlight.has(id),
  );
  if (
    onlyId &&
    !audit.managed.some(({ id }) => id === onlyId) &&
    !progress.reloaded.has(onlyId) &&
    !progress.inFlight.has(onlyId)
  )
    reportReloadFailure(progress, onlyId, "The managed pi is not running");
  for (const { peer, session } of targets) {
    const { id } = session;
    const lockKey = JSON.stringify([
      management.lockResource,
      "reload",
      original.instance,
      id.toLowerCase(),
    ]);
    const release = await tryAcquireLock(
      platform.lockAddress(createHash("sha256").update(lockKey).digest("hex")),
    );
    if (!release) continue;
    try {
      const target = await selectWindowsReloadTarget(context, audit, peer, session);
      if (!target) continue;
      const publication = await respawnWindowsReloadTarget(context, audit, target);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return targets.some(({ session }) => !progress.failed.has(session.id)) ? "wait" : "done";
}

async function selectWindowsReloadTarget(
  context: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  peer: WindowsLifecyclePeer,
  session: ManagedSession,
): Promise<WindowsReloadTarget | undefined> {
  const { config, progress, rights } = context;
  const { id } = session;
  if (progress.failed.has(id)) return;
  const owned = audit.entries.filter((entry) => entry.peer.identity === peer.identity);
  const observed = audit.panes.find(({ peer: observed }) => observed.identity === peer.identity);
  const sameId = audit.entries.filter(({ pi }) => pi?.id.toLowerCase() === id.toLowerCase());
  const owners = audit.managed.filter(
    (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
  );
  if (owners.length !== 1 || sameId.length > 1 || (observed?.rows.length ?? 0) > 1) {
    reportReloadFailure(progress, id, "Cannot uniquely identify the managed pi and pane");
    return;
  }
  const entry = owned[0];
  const pane = entry?.pi;
  if (!entry || !pane || pane.id !== id) {
    if (
      entry &&
      !pane &&
      launchMatchesManagedSession(entry.launch ?? "", session, String(entry.panePid))
    ) {
      if (!entry.right) return;
      const status = await rights.status(entry.right);
      if (status.state === "reserved" || status.state === "pending" || status.state === "live")
        return;
      if (status.state === "unknown") throw new Error(`Cannot verify Windows launch for ${id}`);
    }
    reportReloadFailure(progress, id, "The managed pi is not running");
    return;
  }
  if (pane.cwd !== session.cwd || pane.session !== session.session) {
    reportReloadFailure(progress, id, "Conflicting working directories or session ownership");
    return;
  }
  if (!windowsPaneIsWaiting(config, entry) || !entry.launch) return;
  if (entry.right) {
    const status = await rights.status(entry.right);
    const child = inspectWindowsProcess(pane.pid);
    if (
      status.state !== "live" ||
      !("receipt" in status) ||
      child.state !== "live" ||
      status.receipt.child.pid !== pane.pid ||
      status.receipt.child.creationTime !== child.identity.creationTime
    )
      throw new Error(`Cannot verify the current Windows pi launch for ${id}`);
  }
  return { session, entry, pane };
}

async function respawnWindowsReloadTarget(
  context: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
  { session, entry, pane }: WindowsReloadTarget,
): Promise<Omit<WindowsReloadPublication, "release"> | undefined> {
  const { config, management, rights, progress } = context;
  const { peer, paneId } = entry;
  const basis = { instance: audit.basis.instance, witnesses: [peer.identity] };
  const readPane = (fields: string[]) =>
    readWindowsPeerPaneFields(management.scope, audit, peer, paneId, fields);
  const run = (commands: string[][]) =>
    runWindowsPeerPaneCommands(management.scope, audit, peer, paneId, commands);
  const oldPids = new Set([pane.pid, pane.panePid]);
  const processes = captureWindowsProcesses(oldPids);
  if (processes.length !== oldPids.size) return;
  const savedFile = lstatSync(pane.file, { throwIfNoEntry: false });
  if (savedFile && !savedFile.isFile())
    throw new Error(`Invalid saved conversation file: ${pane.file}`);
  const preserveWarm = pane.warm && !savedFile;
  const launchToken = randomUUID();
  const right = randomUUID();
  const startup = `pi-mux-startup-${randomUUID()}`;
  const desired: Record<string, string> = {
    ...config.env,
    PI_CODING_AGENT_DIR: config.agentDir,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startup,
    [WINDOWS_RIGHT_ENV]: right,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const { commands, inheritedOverrides } = await windowsReloadEnvironment(run, desired);
  const launcher = inspectWindowsProcess(process.pid);
  if (launcher.state !== "live") throw new Error("Cannot identify the Windows reload launcher");
  await snapshotWindowsReload(context, audit);
  const route: WindowsReloadRoute = {
    name: peer.name,
    identity: peer.identity,
    instance: basis.instance,
    pane: paneId,
    session: pane.session,
    id: pane.id,
    cwd: pane.cwd,
    launchToken,
    launcher: launcher.identity,
    inheritedOverrides,
  };
  const invocation = compiledEntry()
    ? [process.execPath]
    : [process.execPath, fileURLToPath(import.meta.url)];
  const command = [
    config.pi,
    ...(savedFile ? ["--session", pane.file] : ["--session-id", pane.id]),
    "-e",
    config.extension,
    "--",
    `/${startup}`,
  ];
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const respawn = [
    "respawn-pane",
    "-k",
    "-t",
    paneId,
    "-c",
    pane.cwd,
    "--",
    ...invocation,
    "windows-claim-launch",
    right,
    encode(command),
    encode(route),
  ];
  const last = await readPane([
    "session_id",
    "pane_pid",
    "pane_dead",
    "PI_TMUX_SESSION_ID",
    "PI_TMUX_TEMPORARY",
    "session_path",
    "@pi-tmux-session",
    "@pi-mux-launch",
    WINDOWS_RIGHT_OPTION,
    "@pi_session_state",
    "@pi-mux-state-source",
    "@pi-mux-pending-restart-blocker",
  ]);
  const [
    sessionId,
    pid,
    dead,
    id,
    temporary,
    cwd,
    metadata,
    launch,
    paneRight,
    state,
    owner,
    blocker,
  ] = last;
  if (
    sessionId !== pane.session ||
    Number(pid) !== pane.panePid ||
    dead !== "0" ||
    id !== pane.id ||
    cwd !== pane.cwd ||
    temporary !== (session.temporary ? id : "") ||
    metadata !== pane.metadata ||
    launch !== entry.launch ||
    paneRight !== entry.right ||
    processes.some(
      (process) => observeWindowsIdentity(process, inspectWindowsProcess) !== "present",
    ) ||
    !windowsPaneIsWaiting(config, { ...entry, state, owner, blocker })
  )
    return;

  if (!session.temporary)
    await management.keepRestoring(basis, session.id, windowsClaimLock(management));
  try {
    await run([
      ...commands,
      ["set-option", "-pu", "-t", paneId, "@pi-tmux-session"],
      ["set-option", "-pu", "-t", paneId, "@pi-mux-launch"],
      ["set-option", "-pu", "-t", paneId, WINDOWS_RIGHT_OPTION],
      ...clearStateOptions(paneId).filter((args) => args.at(-1) !== "@pi_session_state_pending"),
      respawn,
    ]);
    await waitForWindowsExit(processes, {
      timeoutMs: STARTUP_TIMEOUT_MS,
      pollMs: POLL_INTERVAL_MS,
    });
    const [nextSession, nextPid, nextDead, nextRight] = await readPane([
      "session_id",
      "pane_pid",
      "pane_dead",
      WINDOWS_RIGHT_ENV,
    ]);
    if (
      nextSession !== pane.session ||
      !/^[1-9]\d*$/.test(nextPid ?? "") ||
      Number(nextPid) === pane.panePid ||
      nextDead !== "0" ||
      nextRight !== right
    )
      throw new Error("Cannot verify the Windows reload replacement pane");
    const reserved = await rights.reserveAfterLifecycleAudit(
      [conversationLaunchKey(pane.id)],
      basis,
      { token: right },
    );
    if (reserved.state !== "reserved") throw new Error("A Windows pi launch is still active");
    const claimDeadlineMs = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      const status = await rights.status(right);
      if (status.state === "live") break;
      if (status.state !== "reserved")
        throw new Error("Cannot confirm the Windows reload launch was claimed");
      if (Date.now() >= claimDeadlineMs) {
        if (await rights.cancelUnclaimed(right))
          throw new Error("Timed out waiting for the Windows reload launch claim");
        if ((await rights.status(right)).state === "live") break;
        throw new Error("Cannot confirm the Windows reload launch after the claim timeout");
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    return {
      pane,
      launchToken,
      preserveWarm,
      route,
      right,
      deadlineMs: Date.now() + STARTUP_TIMEOUT_MS,
    };
  } catch (error) {
    await rights.cancelUnclaimed(right);
    await management.assertLive(context.original);
    reportReloadFailure(progress, pane.id, errorMessage(error));
  }
}

async function snapshotWindowsReload(
  { config, management }: WindowsReloadContext,
  audit: WindowsLifecycleAudit,
): Promise<void> {
  const previous = readSnapshot(config);
  const { basis } = audit;
  if (previous?.generation && previous.generation !== basis.instance)
    throw new Error("Snapshot belongs to another psmux generation");
  const retained = new Set(audit.startup.restoring);
  const suppressed = new Set(
    audit.managed.filter(({ temporary }) => temporary).map(({ id }) => id.toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const { id } of audit.managed) {
    const key = id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sessions = uniqueCandidates([
    ...(previous?.sessions ?? []).filter(({ id }) => {
      const key = id.toLowerCase();
      return !suppressed.has(key) && (retained.has(key) || (counts.get(key) ?? 0) > 1);
    }),
    ...audit.ownership
      .filter(
        ({ peer, session }) =>
          !session.temporary &&
          counts.get(session.id.toLowerCase()) === 1 &&
          audit.entries.some((entry) => entry.peer.identity === peer.identity),
      )
      .map(({ session: { id, cwd } }) => ({ id, cwd })),
  ]);
  await management.assertLive(basis);
  writeSnapshot(config, {
    version: 1,
    generation: basis.instance,
    cwds: previous?.cwds ?? [],
    sessions,
  });
}

async function windowsReloadEnvironment(
  run: (commands: string[][]) => Promise<string>,
  desired: Record<string, string>,
): Promise<{ commands: string[][]; inheritedOverrides: WindowsReloadRoute["inheritedOverrides"] }> {
  const current = await run([["show-environment", "-s"]]);
  const global = await run([["show-environment", "-gs"]]);
  const exported = (text: string) =>
    [...text.replace(/"(?:\\.|[^"\\])*"/gs, "").matchAll(/; export ([^;\n]+);/g)].map(
      (match) => match[1]!,
    );
  const desiredKeys = new Set(Object.keys(desired).map((key) => key.toUpperCase()));
  const stale = [
    ...new Set([...exported(current), ...exported(global), ...PARENT_ENV_KEYS]),
  ].filter(
    (key) =>
      !desiredKeys.has(key.toUpperCase()) &&
      !GENERATED_ENV_KEYS.has(key.toUpperCase()) &&
      !PSMUX_ROUTING.has(key.toUpperCase()),
  );
  const commands: string[][] = [];
  const inheritedOverrides: WindowsReloadRoute["inheritedOverrides"] = [];
  for (const key of stale) {
    if (platform.acceptsTmuxEnvironmentKey(key)) commands.push(["set-environment", "-r", key]);
    else if (/^[^=\0\r\n]+$/.test(key)) inheritedOverrides.push([key, null]);
  }
  for (const [key, value] of Object.entries(desired)) {
    if (GENERATED_ENV_KEYS.has(key.toUpperCase()) || PSMUX_ROUTING.has(key.toUpperCase())) continue;
    const supported = platform.acceptsTmuxEnvironmentKey(key);
    if (!supported || /[\r\n]/.test(value) || value === "-t") {
      if (supported) commands.push(["set-environment", "-r", key]);
      inheritedOverrides.push([key, value]);
    } else {
      commands.push(["set-environment", key, value]);
    }
  }
  return { commands, inheritedOverrides };
}

async function confirmWindowsReloadPublications(context: WindowsReloadContext): Promise<void> {
  const { config, management, original, progress, rights } = context;
  if (!progress.inFlight.size) return;
  const audit = await management.audit("#{pane_id}");
  if (!launchBasisStillLive(original, audit.basis))
    throw new Error("Dedicated psmux generation changed during reload publication");
  for (const [id, pending] of progress.inFlight) {
    const { route, pane, launchToken, preserveWarm, right, release, deadlineMs } = pending;
    const peer = findWindowsReloadPeer(audit, route);
    const status = await rights.status(right);
    if (
      !peer ||
      status.state === "ended" ||
      status.state === "missing" ||
      status.state === "unknown"
    ) {
      reportReloadFailure(progress, id, "Cannot confirm the Windows reload launch");
    } else {
      const [session, pid, dead, sessionId, cwd, metadata, launch, paneRight] =
        await readWindowsPeerPaneFields(management.scope, audit, peer, route.pane, [
          "session_id",
          "pane_pid",
          "pane_dead",
          "PI_TMUX_SESSION_ID",
          "session_path",
          "@pi-tmux-session",
          "@pi-mux-launch",
          WINDOWS_RIGHT_OPTION,
        ]);
      if (session !== pane.session || dead !== "0" || sessionId !== id || cwd !== pane.cwd) {
        reportReloadFailure(progress, id, "The managed pane changed before publication");
      } else if (
        status.state === "live" &&
        "receipt" in status &&
        paneRight === right &&
        matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch)
      ) {
        const published = JSON.parse(Buffer.from(metadata!, "base64").toString("utf8"));
        if (
          published.processPid === status.receipt.child.pid &&
          published.cwd === pane.cwd &&
          published.startup === "ready" &&
          isAbsolute(published.file ?? "")
        ) {
          await withLock(config, async () => {
            await management.assertLive({ instance: route.instance, witnesses: [peer.identity] });
            await rights.complete(right, status.receipt);
            if (management.startupState(audit.basis)?.restoring.includes(id.toLowerCase()))
              await management.clearRestoring(audit.basis, id, windowsClaimLock(management));
          });
          progress.reloaded.add(id);
          console.log(`reloaded ${id}`);
        }
      }
      if (!progress.reloaded.has(id) && !progress.failed.has(id)) {
        if (Date.now() < deadlineMs) continue;
        reportReloadFailure(progress, id, "pi startup timed out during reload");
      }
    }
    if (progress.failed.has(id)) await rights.cancelUnclaimed(right);
    progress.inFlight.delete(id);
    await release();
  }
}

async function reloadPanes(config: Config, onlyId?: string): Promise<number> {
  if (platform.windows) return await reloadWindowsPanes(config, onlyId);
  const original = await withLock(config, () => serverLifetime(config));
  if (!original) {
    if (onlyId !== undefined)
      throw new Error(`Cannot reload session ${onlyId}: the dedicated server is not running`);
    return await withLock(config, async () => {
      if (await serverLifetime(config)) throw new Error("Dedicated server changed during reload");
      prepareDirectory(config.directory);
      return (await startAndRestore(config, true)).failures > 0 ? 2 : 0;
    });
  }
  if (!original.generation) throw new Error("Dedicated server has not been initialized by pi-mux");
  await withLock(config, async () => {
    await verifyServerLifetime(config, original, "reload");
    readSnapshot(config);
    if (onlyId) await validateReloadTarget(config, onlyId);
    await bootstrapServer(config, onlyId === undefined ? "start" : "existing");
  });
  const progress: ReloadProgress = { reloaded: new Set(), failed: new Set(), inFlight: new Map() };
  let schedulingFailure: { cause: unknown } | undefined;
  try {
    while (true) {
      const step = schedulingFailure
        ? "done"
        : await withLock(config, () => startNextReload(config, original, progress, onlyId)).catch(
            (cause: unknown) => {
              schedulingFailure = { cause };
              return "done" as const;
            },
          );
      await confirmReloadPublications(config, original, progress);
      if (step === "done" && progress.inFlight.size === 0) {
        if (schedulingFailure) throw schedulingFailure.cause;
        return progress.failed.size > 0 ? 2 : 0;
      }
      if (step !== "started") await Bun.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await Promise.all([...progress.inFlight.values()].map(({ release }) => release()));
  }
}

async function startNextReload(
  config: Config,
  original: ServerLifetime,
  progress: ReloadProgress,
  onlyId?: string,
): Promise<"started" | "wait" | "done"> {
  await verifyServerLifetime(config, original, "reload");
  const targets = await scanReloadTargets(config, progress, onlyId);
  if (!targets) return "done";
  for (const target of targets) {
    const { id } = target.pane;
    const scope = `\0reload\0${original.pid}\0${original.generation}\0${id}`;
    const release = await tryAcquireLock(lockAddress(config, scope));
    if (!release) continue;
    try {
      const publication = await respawnReloadTarget(config, original, target, progress);
      if (!publication) continue;
      progress.inFlight.set(id, { ...publication, release });
      return "started";
    } finally {
      if (!progress.inFlight.has(id)) await release();
    }
  }
  return "wait";
}

function reportReloadFailure(
  progress: Pick<ReloadProgress, "failed">,
  id: string,
  reason: string,
): void {
  if (progress.failed.has(id)) return;
  progress.failed.add(id);
  console.error(`pi-mux: reload ${id}: ${reason}`);
}

async function validateReloadTarget(config: Config, id: string): Promise<void> {
  if ((await managedSessions(config)).some((session) => session.id === id)) return;
  const known =
    readSnapshot(config)?.sessions.some((session) => session.id === id) ||
    (await findSaved(config, id)) !== undefined;
  if (known) throw new Error(`The conversation is not running: ${id}`);
  throw new Error(`Session not found (use the complete ID): ${id}`);
}

async function scanReloadTargets(
  config: TmuxConfig,
  progress: ReloadProgress,
  onlyId?: string,
): Promise<ReloadTarget[] | undefined> {
  const { reloaded, failed, inFlight } = progress;
  const managed = (await managedSessions(config)).filter(
    ({ id }) =>
      (!onlyId || id === onlyId) && !reloaded.has(id) && !failed.has(id) && !inFlight.has(id),
  );
  if (managed.length === 0) return;
  const panes = await livePanes(config, "list");
  const owned = panes.filter((pane) =>
    managed.some((session) => session.session === pane.session && session.id === pane.id),
  );
  for (const pane of owned) {
    if (failed.has(pane.id)) continue;
    const conflicts = owned.filter((entry) => entry.id === pane.id);
    if (conflicts.length > 1) {
      const reason =
        new Set(conflicts.map((entry) => entry.cwd)).size > 1
          ? `Conflicting working directories for conversation ${pane.id}`
          : "Multiple pi processes match the conversation ID";
      reportReloadFailure(progress, pane.id, reason);
    }
  }
  const pending = managed.filter(({ id }) => !failed.has(id));
  if (pending.length === 0) return;
  const rowsOfSession = await tmuxQueries(
    config,
    pending.map((session) => [
      "list-panes",
      "-s",
      "-t",
      session.session,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_dead}",
    ]),
  );
  const rows = pending.map((session, index) =>
    rowsOfSession[index]!.stdout.trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pane, pid, dead] = line.split("\t");
        return { pane: pane ?? "", pid: pid ?? "", dead: dead ?? "" };
      })
      .filter((row) => row.pane && /^[1-9]\d*$/.test(row.pid) && row.dead === "0")
      .map((row) => ({
        ...row,
        published: owned.some(
          (entry) =>
            entry.pane === row.pane && entry.session === session.session && entry.id === session.id,
        ),
      })),
  );
  const unpublished = rows.flatMap((sessionRows, index) =>
    sessionRows.filter((row) => !row.published).map((row) => ({ session: pending[index]!, row })),
  );
  const launches = await tmuxQueries(
    config,
    unpublished.map(({ row }) => ["show-options", "-pqv", "-t", row.pane, "@pi-mux-launch"]),
  );
  const bootingBySession = new Map<string, number>();
  for (const [index, { session, row }] of unpublished.entries()) {
    let record: unknown;
    try {
      record = JSON.parse(launches[index]!.stdout);
    } catch {
      record = undefined;
    }
    if (
      isRecord(record) &&
      record.id === session.id &&
      typeof record.token === "string" &&
      (record.pid === Number(row.pid) ||
        (Number.isSafeInteger(record.pid) &&
          Number(record.pid) > 0 &&
          !platform.processIsAlive(Number(record.pid))))
    )
      bootingBySession.set(session.id, (bootingBySession.get(session.id) ?? 0) + 1);
  }
  const states = await tmuxQueries(
    config,
    owned.flatMap((pane) => [
      ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"],
      ["show-options", "-pqv", "-t", pane.pane, "@pi-mux-pending-restart-blocker"],
    ]),
  );
  const inspected = new Map(
    owned.map((pane, index) => [
      pane.pane,
      {
        state: states[index * 2]!,
        blocker: states[index * 2 + 1]!,
      },
    ]),
  );
  const targets: ReloadTarget[] = [];
  for (const [index, session] of pending.entries()) {
    const publishedRows = rows[index]!.filter((row) => row.published);
    if (publishedRows.length === 0) {
      if ((bootingBySession.get(session.id) ?? 0) > 0) continue;
      reportReloadFailure(progress, session.id, "The managed pi is not running");
      continue;
    }
    for (const row of publishedRows) {
      const pane = owned.find((entry) => entry.pane === row.pane)!;
      const inspection = inspected.get(pane.pane)!;
      if (inspection.blocker.exitCode !== 0)
        throw new Error(`Cannot inspect pending reload state: ${pane.id}`);
      if (inspection.state.exitCode !== 0)
        throw new Error(`Cannot inspect reload state: ${pane.id}`);
      const ready =
        !inspection.blocker.stdout.trim() &&
        parseSessionState(inspection.state.stdout.trimEnd(), pane.id) === "waiting-user" &&
        pane.startup !== "accepted";
      if (!ready) continue;
      targets.push({ session, pane });
      break;
    }
  }
  return targets;
}

async function respawnReloadTarget(
  config: Config,
  original: ServerLifetime,
  { session, pane }: ReloadTarget,
  progress: ReloadProgress,
): Promise<ReloadPublication | undefined> {
  const state = await tmux(config, ["show-options", "-pqv", "-t", pane.pane, "@pi_session_state"]);
  if (state.exitCode !== 0) throw new Error(`Cannot inspect reload state: ${pane.id}`);
  const blocker = await tmux(config, [
    "show-options",
    "-pqv",
    "-t",
    pane.pane,
    "@pi-mux-pending-restart-blocker",
  ]);
  if (blocker.exitCode !== 0) throw new Error(`Cannot inspect pending reload state: ${pane.id}`);
  if (
    blocker.stdout.trim() ||
    parseSessionState(state.stdout.trimEnd(), pane.id) !== "waiting-user"
  )
    return;
  await tmux(config, ["set-option", "-g", "@pi-mux-restart-veto", ""]);
  await snapshotSessions(config, original.generation, "repair");
  const saved = readSnapshot(config);
  if (!saved || saved.generation !== original.generation)
    throw new Error("Cannot confirm reload snapshot");
  await verifyServerLifetime(config, original, "reload");
  const launchToken = randomUUID();
  const startupCommand = `pi-mux-startup-${randomUUID()}`;
  const hasSavedFile = existsSync(pane.file);
  const preserveWarm = pane.warm && !hasSavedFile;
  const desired: Record<string, string> = {
    ...config.env,
    PI_TMUX_SESSION_ID: pane.id,
    PI_TMUX_LAUNCH_TOKEN: launchToken,
    PI_TMUX_STARTUP_COMMAND: startupCommand,
    ...(session.temporary ? { PI_TMUX_TEMPORARY: pane.id } : {}),
    ...(preserveWarm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  await refreshSessionEnvironment(config, session.session, desired);
  const removed = await excludedGlobalEnvironment(config, desired);
  const selection = hasSavedFile ? ["--session", pane.file] : ["--session-id", pane.id];
  const paneCommand = platform.paneCommand(
    [config.pi, ...selection, "-e", config.extension, "--", `/${startupCommand}`],
    removed,
    desired,
  );
  const canRespawn = [
    "#{==:#{@pi-mux-restart-veto},}",
    `#{==:#{pane_id},${pane.pane}}`,
    `#{==:#{pane_pid},${pane.panePid}}`,
    "#{==:#{pane_dead},0}",
    "#{==:#{@pi-mux-pending-restart-blocker},}",
    '#{m:*"state":"waiting-user"*,#{@pi_session_state}}',
  ].reduce((left, right) => `#{&&:${left},${right}}`);
  const recoveryMarker = saved.sessions.some(({ id }) => id === pane.id)
    ? [tmuxArguments(["set-option", "-g", `@pi-mux-restoring-${pane.id}`, "1"])]
    : [];
  const reloadBranch = tmuxArguments([
    "if-shell",
    "-t",
    pane.pane,
    "-F",
    canRespawn,
    [
      ...recoveryMarker,
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi-tmux-session"]),
      tmuxArguments([
        "respawn-pane",
        "-k",
        "-t",
        pane.pane,
        "--",
        ...platform.tmuxPaneCommand(paneCommand),
      ]),
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi_session_state"]),
      tmuxArguments(["set-option", "-pu", "-t", pane.pane, "@pi-mux-state-source"]),
      tmuxArguments([
        "set-option",
        "-pF",
        "-t",
        pane.pane,
        "@pi-mux-launch",
        `{"id":"${pane.id}","pid":#{pane_pid},"token":"${launchToken}"}`,
      ]),
    ].join(" ; "),
    "display-message -p PI_MUX_RELOAD_WAIT",
  ]);
  const respawned = await tmux(
    config,
    [
      "if-shell",
      "-F",
      `#{&&:#{==:#{pid},${original.pid}},#{==:#{@pi-mux-generation},${original.generation}}}`,
      reloadBranch,
      "display-message -p PI_MUX_RELOAD_SERVER_CHANGED",
    ],
    true,
  );
  if (respawned.stdout.includes("PI_MUX_RELOAD_SERVER_CHANGED"))
    throw new Error("Dedicated server changed during reload");
  if (respawned.exitCode !== 0) {
    await verifyServerLifetime(config, original, "reload");
    reportReloadFailure(progress, pane.id, `tmux if-shell failed: ${respawned.stderr.trim()}`);
    return;
  }
  if (respawned.stdout.includes("PI_MUX_RELOAD_WAIT")) return;
  return { pane, launchToken, preserveWarm, deadlineMs: Date.now() + STARTUP_TIMEOUT_MS };
}

async function confirmReloadPublications(
  config: Config,
  original: ServerLifetime,
  progress: ReloadProgress,
): Promise<void> {
  if (progress.inFlight.size === 0) return;
  const list = await tmux(
    config,
    [
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{pane_id}\t#{pid}\t#{@pi-mux-generation}\t#{pane_pid}\t#{pane_dead}\t#{@pi-tmux-session}\t#{@pi-mux-launch}",
    ],
    true,
  );
  if (list.exitCode !== 0 || !list.stdout.trim()) {
    await verifyServerLifetime(config, original, "reload");
    const noPanes =
      list.stderr.includes("no sessions") || list.stderr.includes("no current target");
    if (list.exitCode !== 0 && !noPanes)
      throw new Error(`tmux list-panes failed: ${list.stderr.trim()}`);
  }
  const rows = new Map<string, string[]>();
  for (const line of list.stdout.trimEnd().split("\n").filter(Boolean)) {
    const [session, paneId, serverPid, generation, ...publication] = line.split("\t");
    if (Number(serverPid) !== original.pid || generation !== original.generation)
      throw new Error("Dedicated server changed during reload");
    rows.set(`${session}:${paneId}`, publication);
  }
  for (const [id, { pane, launchToken, preserveWarm, deadlineMs, release }] of progress.inFlight) {
    const [pid, dead, metadata, launch] = rows.get(`${pane.session}:${pane.pane}`) ?? [];
    if (!pid || dead === "1") {
      reportReloadFailure(progress, id, "pi exited before reload was recorded");
    } else if (
      matchesReloadPublication(pane, Number(pid), launchToken, preserveWarm, metadata, launch)
    ) {
      progress.reloaded.add(id);
      console.log(`reloaded ${id}`);
    } else if (Date.now() >= deadlineMs) {
      reportReloadFailure(progress, id, "pi startup timed out during reload");
    } else {
      continue;
    }
    progress.inFlight.delete(id);
    await release();
  }
}

function matchesReloadPublication(
  original: Pane,
  panePid: number,
  token: string,
  preserveWarm: boolean,
  encodedMetadata?: string,
  launch?: string,
): boolean {
  if (
    !Number.isSafeInteger(panePid) ||
    panePid <= 0 ||
    panePid === original.panePid ||
    !encodedMetadata ||
    !launch ||
    !matchesLaunch(launch, original.id, panePid, token)
  )
    return false;

  try {
    const metadata = JSON.parse(Buffer.from(encodedMetadata, "base64").toString("utf8"));
    return (
      metadata?.id === original.id &&
      metadata.pid === panePid &&
      metadata.token === token &&
      (!preserveWarm || (metadata.startup === "ready" && metadata.warm === true))
    );
  } catch {
    return false;
  }
}

async function excludedGlobalEnvironment(
  config: TmuxConfig,
  desired: Record<string, string>,
): Promise<string[]> {
  const global = await tmux(config, ["show-environment", "-gs"]);
  const assignments = global.stdout.replace(/"(?:\\.|[^"\\])*"/gs, "");
  return [...assignments.matchAll(/; export ([^;\n]+);/g)]
    .map((match) => match[1]!)
    .filter((key) => !Object.hasOwn(desired, key) && !GENERATED_ENV_KEYS.has(key));
}

async function refreshSessionEnvironment(
  config: TmuxConfig,
  session: string,
  desired: Record<string, string>,
): Promise<void> {
  const current = await tmux(config, ["show-environment", "-t", session]);
  const existing = new Map<string, string | undefined>();
  for (const line of current.stdout.trimEnd().split("\n").filter(Boolean)) {
    if (line.startsWith("-")) {
      existing.set(line.slice(1), undefined);
      continue;
    }
    const key = line.slice(0, line.indexOf("="));
    if (key) existing.set(key, line.slice(key.length + 1));
  }
  for (const [key, value] of Object.entries(desired))
    if (platform.acceptsTmuxEnvironmentKey(key) && existing.get(key) !== value)
      await tmux(config, ["set-environment", "-t", session, key, value]);
  for (const [key, value] of existing)
    if (
      value !== undefined &&
      !Object.hasOwn(desired, key) &&
      platform.acceptsTmuxEnvironmentKey(key)
    )
      await tmux(config, ["set-environment", "-u", "-t", session, key]);
}

type WindowsBootstrap = "start" | "fresh" | WindowsManagementBasis;

async function bootstrapServer(
  config: Config,
  mode: WindowsBootstrap | "existing" = "start",
): Promise<{ generation: string; basis?: WindowsManagementBasis }> {
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
  if (platform.windows) {
    const management = windowsManagement(config);
    const existing = typeof mode === "object" ? mode : await management.currentBasis();
    let proof: string | undefined;
    if (existing) {
      if (mode === "fresh")
        throw new Error("A different psmux generation appeared before fresh bootstrap");
    } else if (mode !== "existing") {
      proof = randomUUID();
      await tmux({ ...config, env: { ...config.env, [WINDOWS_BOOTSTRAP_PROOF]: proof } }, [
        "start-server",
      ]);
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!(await management.currentBasis()) && Date.now() < deadline) {
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    }
    const audit = await management.audit("#{pane_id}", { requireRestored: false });
    if (existing && !launchBasisStillLive(existing, audit.basis))
      throw new Error("The dedicated psmux management generation changed during startup");
    await configureWindowsPeer(management.scope, audit, {
      configFile: config.tmuxConfig,
      hookCommand,
      proof,
    });
    await management.assertLive(audit.basis);
    return { generation: audit.basis.instance, basis: audit.basis };
  }
  if (mode !== "existing") await tmux(config, ["start-server"]);
  await tmux(config, ["source-file", config.tmuxConfig]);
  const existing = await serverOption(config, "@pi-mux-generation");
  const generation = existing || randomUUID();
  if (!existing) await tmux(config, ["set-option", "-g", "@pi-mux-generation", generation]);
  await tmux(config, ["set-option", "-g", "@pi-mux-snapshot", hookCommand]);
  return { generation };
}

async function startAndRestore(
  config: Config,
  restoreRequested: boolean,
  temporaryTarget?: string,
  bootstrap: WindowsBootstrap = "start",
): Promise<{ failures: number; basis?: WindowsManagementBasis }> {
  const { generation, basis } = await bootstrapServer(config, bootstrap);
  const management = basis ? windowsManagement(config) : undefined;
  if (management && basis) {
    await management.assertLive(basis);
    if (!restoreRequested && management.startupState(basis)?.restored)
      return { failures: 0, basis };
    const restoring = (readSnapshot(config)?.sessions ?? [])
      .filter(({ id }) => id !== temporaryTarget)
      .map(({ id }) => id);
    await management.prepareStartup(basis, restoring, windowsClaimLock(management));
  }
  const restored = platform.windows ? "" : await serverOption(config, "@pi-mux-restored");
  if (!restoreRequested && restored === generation) return { failures: 0 };
  let failures = 0;
  try {
    failures = await restoreSessions(config, generation, temporaryTarget, basis);
  } catch (error) {
    console.error(`pi-mux: restore failed: ${errorMessage(error)}`);
    failures++;
  }
  if (management && basis) {
    await management.markRestored(basis, windowsClaimLock(management));
    await management.assertLive(basis);
  } else await tmux(config, ["set-option", "-g", "@pi-mux-restored", generation]);
  return { failures, basis };
}

async function restoreSessions(
  config: Config,
  generation: string,
  temporaryTarget?: string,
  windowsBasis?: WindowsManagementBasis,
): Promise<number> {
  const management = windowsBasis ? windowsManagement(config) : undefined;
  const previous = readSnapshot(config);
  const temporaryIds = new Set(
    (await managedSessions(config)).filter((entry) => entry.temporary).map((entry) => entry.id),
  );
  if (management && windowsBasis) await management.assertLive(windowsBasis);
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
      const resolution = await resolveSaved(config, candidate.id, candidate.cwd, windowsBasis);
      if (resolution.saved) {
        const restored = await openResolvedSession(
          config,
          candidate.id,
          resolution,
          "normal",
          windowsBasis,
        );
        if (restored.startup !== "ready")
          throw new Error("Running pi has not confirmed initialization completion");
      } else {
        console.error(`pi-mux: restore ${candidate.id}: saved conversation not found; removed`);
        state = { ...state, sessions: state.sessions.filter((entry) => entry.id !== candidate.id) };
      }
      if (management && windowsBasis) await management.assertLive(windowsBasis);
      writeSnapshot(config, state);
      if (management && windowsBasis) {
        await management.clearRestoring(windowsBasis, candidate.id, windowsClaimLock(management));
      } else await tmux(config, ["set-option", "-gu", `@pi-mux-restoring-${candidate.id}`]);
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
  const markers = platform.windows
    ? await Promise.all(
        candidates.map(async ({ id }) => ({
          exitCode: 0,
          stderr: "",
          stdout: await serverOption(config, `@pi-mux-restoring-${id}`),
        })),
      )
    : await tmuxQueries(
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
  if (platform.windows) return;
  for (const { id } of candidates)
    await tmux(config, ["set-option", "-g", `@pi-mux-restoring-${id}`, "1"]);
}

async function managedSessions(config: TmuxConfig, strict = false): Promise<ManagedSession[]> {
  if (platform.windows) {
    const management = windowsManagement(config);
    const basis = await management.currentBasis();
    if (!basis && !strict) return [];
    const audit = await management.audit(
      "#{session_id}\t#{PI_TMUX_SESSION_ID}\t#{PI_TMUX_TEMPORARY}\t#{session_path}\t#{pane_dead}\t#{PI_MUX_WINDOWS_START_RIGHT}",
      { requireRestored: false },
    );
    const rights = management.createLaunchRights(windowsClaimLock(management));
    const managed: ManagedSession[] = [];
    for (const { peer, rows } of audit.panes) {
      let candidate: ManagedSession | undefined;
      for (const row of rows) {
        const parts = row.split("\t");
        const [session, id, temporary, cwd, dead, token] = parts;
        if (parts.length !== 6 || !/^\$\d+$/.test(session ?? "") || !["0", "1"].includes(dead!))
          throw new Error(`Invalid Windows managed session in ${peer.name}`);
        if (!id || dead === "1") continue;
        if (
          !SESSION_ID_PATTERN.test(id) ||
          !isAbsolute(cwd ?? "") ||
          (temporary && temporary !== id)
        )
          throw new Error(`Invalid Windows conversation metadata in ${peer.name}`);
        if (token) {
          if (!UUID.test(token)) throw new Error(`Invalid Windows launch token in ${peer.name}`);
          const status = await rights.status(token);
          if (["missing", "ended", "reserved"].includes(status.state)) continue;
          if (status.state !== "live")
            throw new Error(`Cannot verify Windows launch in ${peer.name}`);
        }
        const current = { session: session!, id, cwd: cwd!, temporary: temporary === id };
        if (candidate && JSON.stringify(candidate) !== JSON.stringify(current))
          throw new Error(`Ambiguous Windows conversation metadata in ${peer.name}`);
        candidate = current;
      }
      if (candidate) managed.push(candidate);
    }
    await management.assertLive(audit.basis);
    return managed;
  }
  const listed = await tmux(config, ["list-sessions", "-F", "#{session_id}"], true);
  if (listed.exitCode !== 0) {
    if (!strict && (serverIsAbsent(config, listed.stderr) || listed.stderr.includes("no sessions")))
      return [];
    throw new Error(`Cannot inspect managed sessions: ${listed.stderr.trim()}`);
  }
  const targets = listed.stdout.trimEnd().split("\n").filter(Boolean);
  if (strict && targets.some((session) => !/^\$\d+$/.test(session)))
    throw new Error("Invalid tmux session inventory");
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
    if (!environment.stdout.startsWith("PI_TMUX_SESSION_ID=") || !SESSION_ID_PATTERN.test(id))
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
  if (
    platform.windows &&
    (option === "@pi-mux-generation" || option.startsWith("@pi-mux-restor"))
  ) {
    const management = windowsManagement(config);
    const basis = await management.currentBasis();
    if (option === "@pi-mux-generation") return basis?.instance ?? "";
    const state = basis && management.startupState(basis);
    if (option === "@pi-mux-restored") return state?.restored ? state.instance : "";
    return state?.restoring.includes(option.slice("@pi-mux-restoring-".length).toLowerCase())
      ? "1"
      : "";
  }
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
  if (platform.windows) return;
  const directory = openSync(config.stateDirectory, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

async function createNew(
  config: Config,
  request?: string,
  windowsBasis?: WindowsManagementBasis,
): Promise<Pane> {
  const cwd = process.cwd();
  if (request === undefined) {
    const candidates = (await livePanes(config, "list")).filter(
      (pane) => pane.warm && pane.cwd === cwd && pane.startup === "ready" && !existsSync(pane.file),
    );
    const managed = candidates.length > 0 ? await managedSessions(config) : [];
    for (const pane of candidates) {
      if (
        !managed.some(
          (session) =>
            session.session === pane.session && session.id === pane.id && session.cwd === cwd,
        )
      )
        continue;
      const launch = await tmux(config, [
        "show-options",
        "-pqv",
        "-t",
        pane.pane,
        "@pi-mux-launch",
      ]);
      const metadata = JSON.parse(Buffer.from(pane.metadata, "base64").toString("utf8"));
      if (matchesLaunch(launch.stdout, pane.id, pane.panePid, metadata.token)) return pane;
    }
  }
  const id = randomUUID();
  const name = sessionName(id);
  const created = await createSession(
    config,
    {
      id,
      cwd,
      ...(request === undefined ? { warm: true } : { request }),
    },
    name,
    windowsBasis,
  );
  if (request !== undefined) return await waitForSession(config, created ?? name, id, "accepted");
  return await waitForSession(config, created ?? name, id);
}

export function firstInputDirectory(
  stateDirectory: string,
  id: string,
  platformName: NodeJS.Platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
): string | undefined {
  if (!UUID.test(id)) return;
  if (platformName === "win32") {
    if (!localAppData || !/^[a-z]:[\\/]/i.test(localAppData)) return;
    return win32.join(localAppData, "pi-mux-first-input", id);
  }
  return join(stateDirectory, "first-input", id);
}

function findFirstInput(config: TmuxConfig, id: string): Candidate | undefined {
  const directory = firstInputDirectory(config.stateDirectory, id);
  if (!directory) return;
  const payload = lstatSync(join(directory, "text"), { throwIfNoEntry: false });
  if (!payload) return;
  if (!payload.isFile() || !platform.ownedFileEntry(payload))
    throw new Error("Unsafe first input file");
  for (const path of [dirname(directory), directory])
    platform.assertDirectorySafety(lstatSync(path), path);
  if (!platform.windows)
    platform.assertDirectorySafety(lstatSync(config.stateDirectory), config.stateDirectory);
  const context = join(directory, "context.json");
  const stat = lstatSync(context);
  if (!stat.isFile() || !platform.ownedFileEntry(stat))
    throw new Error("Unsafe first input context");
  const record = JSON.parse(readFileSync(context, "utf8"));
  if (
    record?.id !== id ||
    typeof record?.cwd !== "string" ||
    !isAbsolute(record.cwd) ||
    typeof record?.request !== "string" ||
    !UUID.test(record.request)
  )
    throw new Error("Invalid first input context");
  return { id, cwd: record.cwd };
}

function matchesLaunch(encoded: string, id: string, panePid: number, token: unknown): boolean {
  if (typeof token !== "string" || !UUID.test(token)) return false;
  try {
    const launch = JSON.parse(encoded);
    return launch?.id === id && launch.pid === panePid && launch.token === token;
  } catch {
    return false;
  }
}

function compiledEntry(): boolean {
  return import.meta.path.startsWith("/$bunfs/") || /^[Bb]:\\+~BUN\\/i.test(import.meta.path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SavedSessionResolution = {
  windowsBasis?: WindowsManagementBasis;
  running?: Pane;
  managed?: ManagedSession;
  saved?: Session;
  recovery?: Candidate;
};

async function resolveSaved(
  config: Config,
  id: string,
  restoreCwd?: string,
  expected?: WindowsManagementBasis,
): Promise<SavedSessionResolution> {
  const inspection = await (
    platform.windows
      ? inspectWindowsBeforeOpen(config, id, expected)
      : inspectRunningSession(config, id).then((result) => ({ ...result, basis: undefined }))
  ).catch((error: unknown) => {
    if (restoreCwd === undefined) throw error;
    return { error };
  });
  const saved = await findSaved(config, id, restoreCwd === undefined ? "open" : "restore");
  if (restoreCwd !== undefined) {
    if (!saved) return {};
    if (saved.cwd !== restoreCwd)
      throw new Error(`Saved working directory differs from snapshot: ${saved.cwd}`);
  }
  if ("error" in inspection) throw inspection.error;

  const { running, managed } = inspection;
  const recovery = !saved && !running && !managed ? findFirstInput(config, id) : undefined;
  if (!running && !managed) {
    const candidate = saved ?? recovery;
    if (!candidate) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (!existsSync(candidate.cwd) || !statSync(candidate.cwd).isDirectory())
      throw new Error(`Session working directory does not exist: ${candidate.cwd}`);
  }
  return {
    running,
    managed,
    saved,
    recovery,
    windowsBasis: inspection.basis,
  };
}

function parseDispatchTicketOperation(args: string[]): DispatchTicketOperation {
  const [ownerId, socket, project, ticketId, sessionName, cwd, prompt] = args;
  if (args.length !== 7) throw new Error("Invalid argument count for inspect --dispatch-ticket");
  if (!ownerId || ownerId !== ownerId.trim() || !SESSION_ID_PATTERN.test(ownerId))
    throw new Error("Invalid ticket owner ID");
  if (!socket || socket.includes("\0")) throw new Error("Invalid ticket dispatch socket");
  if (!project || project === "." || project === ".." || /[/\\\0]/.test(project))
    throw new Error("Invalid ticket project");
  if (
    !ticketId ||
    ticketId.length > DISPATCH_TICKET_ID_MAX_LENGTH ||
    ticketId !== ticketId.trim() ||
    !DISPATCH_TICKET_ID_PATTERN.test(ticketId)
  )
    throw new Error("Invalid ticket ID");
  const nameId = ticketId.replaceAll(".", "_");
  const projectHex = Buffer.from(project, "utf8").toString("hex");
  if (sessionName !== `handle_${nameId}` && sessionName !== `handle_${projectHex}_${nameId}`)
    throw new Error("Invalid ticket tmux session name");
  if (!cwd || !isAbsolute(cwd) || cwd.includes("\0"))
    throw new Error("Ticket workspace must be an absolute path");
  if (!prompt || prompt.includes("\0")) throw new Error("Invalid ticket dispatch prompt");
  return {
    kind: "inspect-dispatch-ticket",
    ownerId,
    socket,
    project,
    ticketId,
    sessionName,
    cwd,
    prompt,
  };
}

type SessionInspection = { state: "present" } | { state: "absent"; file: string | null };
type DispatchTicketLaunch = { state: "present" } | { state: "launched"; session: string };

async function withSessionAudit<T>(
  config: TmuxConfig,
  inspect: (lifetime: ServerLifetime) => Promise<T>,
): Promise<T> {
  const stateDirectory = lstatSync(config.stateDirectory);
  platform.assertDirectorySafety(stateDirectory, config.stateDirectory);
  return await withLock(
    config,
    async () => {
      const lifetime = await serverLifetime(config);
      if (!lifetime) throw new Error("The dedicated tmux server is not running");
      if (!lifetime.generation)
        throw new Error("Dedicated server has not been initialized by pi-mux");
      return await inspect(lifetime);
    },
    "try",
  );
}

async function inspectSession(config: TmuxConfig, id: string): Promise<SessionInspection> {
  try {
    if (platform.windows)
      return await withLock(
        config,
        async () => {
          const { running, managed, starting, restoring, basis } =
            await inspectWindowsRunningSession(config, id);
          const present = running || managed || starting || restoring;
          const saved = present ? undefined : await findSaved(config, id);
          await windowsManagement(config).assertLive(basis!);
          return present ? { state: "present" } : { state: "absent", file: saved?.file ?? null };
        },
        "try",
      );
    return await withSessionAudit<SessionInspection>(config, async (lifetime) => {
      const wasPresent = await auditSessionPresence(config, id);
      const saved = wasPresent ? undefined : await findSaved(config, id);
      const isPresent = wasPresent || (await auditSessionPresence(config, id));
      await verifyServerLifetime(config, lifetime, "inspect");
      return isPresent ? { state: "present" } : { state: "absent", file: saved?.file ?? null };
    });
  } catch (error) {
    if (error instanceof LockBusyError) throw error;
    throw new Error(`Cannot inspect session ${id}: ${errorMessage(error)}`);
  }
}

async function launchDispatchedTicket(
  config: TmuxConfig,
  operation: DispatchTicketOperation,
): Promise<DispatchTicketLaunch> {
  if (!platform.windows && process.platform !== "linux")
    throw new Error("Ticket dispatch launch requires Linux or Windows");
  if (operation.socket !== config.socket)
    throw new Error("Ticket dispatch socket does not match pi-mux");
  const cwd = realpathSync(operation.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
  if (platform.windows)
    return await withLock(
      config,
      async () => {
        const keys = [
          conversationLaunchKey(operation.ownerId),
          ticketLaunchKey(operation.project, operation.ticketId),
        ];
        const management = windowsManagement(config);
        const rights = management.createLaunchRights(windowsClaimLock(management));
        await rights.discardUnclaimed(keys);
        const { running, managed, starting, restoring, basis } = await inspectWindowsRunningSession(
          config,
          operation.ownerId,
        );
        if (running || managed || starting || restoring) return { state: "present" };
        const audit = await management.audit(PANE_FORMAT);
        if (audit.panes.some(({ peer }) => peer.name === operation.sessionName))
          throw new Error(`Ticket tmux session already exists: ${operation.sessionName}`);
        prepareDirectory(config.stateDirectory);
        registerWorkspaces(config, [cwd]);
        const session = await startWindowsLaunch(config, {
          keys,
          basis: basis!,
          name: operation.sessionName,
          cwd,
          ownerId: operation.ownerId,
          environment: { ...config.env, ...dispatchTicketEnvironment(config, operation) },
          command: [executable("pi"), "--", operation.prompt],
        });
        return { state: "launched", session };
      },
      "try",
    );
  return await withSessionAudit<DispatchTicketLaunch>(config, async (lifetime) => {
    const isPresent = await auditSessionPresence(config, operation.ownerId);
    await verifyServerLifetime(config, lifetime, "ticket dispatch launch");
    if (isPresent) return { state: "present" };

    const args = dispatchTicketSessionArgs(config, operation, cwd);
    registerWorkspaces(config, [cwd]);
    const result = await tmux(config, args);
    const session = result.stdout.trimEnd();
    if (!/^\$[0-9]+$/.test(session))
      throw new Error("Cannot identify the created ticket tmux session");
    return { state: "launched", session };
  });
}

function dispatchTicketEnvironment(
  config: TmuxConfig,
  { project, ticketId }: DispatchTicketOperation,
): Record<string, string> {
  const desired: Record<string, string> = {
    PI_CODING_AGENT_DIR: config.agentDir,
    TICKET_DISPATCH_ROLE: "pi",
    TICKET_DISPATCH_PROJECT: project,
    TICKET_DISPATCH_ID: ticketId,
  };
  const keys = ["HOME", "PATH", "PI_CODING_AGENT_SESSION_DIR"];
  if (platform.windows) keys.push("USERPROFILE", "PSMUX_DATA_DIR", "PSMUX_NO_WARM");
  for (const key of keys) {
    const value = config.env[key];
    if (value !== undefined) desired[key] = value;
  }
  return desired;
}

function dispatchTicketSessionArgs(
  config: TmuxConfig,
  operation: DispatchTicketOperation,
  cwd: string,
): string[] {
  const { sessionName, prompt } = operation;
  const desired = dispatchTicketEnvironment(config, operation);
  const unset = [...PARENT_ENV_KEYS].filter(
    (key) => !GENERATED_ENV_KEYS.has(key) && !Object.hasOwn(desired, key),
  );
  if (config.env.PI_CODING_AGENT_SESSION_DIR === undefined)
    unset.push("PI_CODING_AGENT_SESSION_DIR");
  const environment = Object.entries(desired).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const command = platform.paneCommand([executable("pi"), "--", prompt], unset);
  return [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    sessionName,
    "-c",
    cwd.replaceAll("#", "##"),
    ...environment,
    "--",
    `exec ${command}`,
  ].map((arg) => (arg.endsWith(";") ? arg.slice(0, -1) + "\\;" : arg));
}

async function auditSessionPresence(config: TmuxConfig, id: string): Promise<boolean> {
  const marker = await serverOption(config, `@pi-mux-restoring-${id}`);
  if (marker !== "" && marker !== "1") throw new Error("Invalid in-memory restore state");
  const { running, managed } = await inspectRunningSession(config, id, "audit");
  return running !== undefined || managed !== undefined || marker === "1";
}

async function inspectRunningSession(
  config: TmuxConfig,
  id: string,
  mode: "open" | "audit" = "open",
) {
  const isAudit = mode === "audit";
  const allManaged = await managedSessions(config, isAudit);
  const managed = allManaged.filter((session) => session.id === id);
  if (managed.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const running = (await livePanes(config, "list", isAudit ? allManaged : undefined)).filter(
    (pane) => pane.id === id,
  );
  const [active] = running;
  const [target] = managed;
  if (running.length > 1 || (isAudit && active && target && active.session !== target.session))
    throw new Error(`Multiple pi processes are running for session ${id}`);
  if (isAudit && target && !active) {
    const initializing = await initializingPanes(config, [target], []);
    if (initializing.length !== 1)
      throw new Error(`Cannot identify a single starting pi for managed session ${id}`);
  }
  return { running: active, managed: target };
}

async function openExactSession(config: Config, id: string, file: string): Promise<Pane> {
  if (platform.windows)
    return await withLock(
      config,
      async () => {
        const key = conversationLaunchKey(id);
        const management = windowsManagement(config);
        await management.createLaunchRights(windowsClaimLock(management)).discardUnclaimed([key]);
        const { running, managed, starting, restoring, basis } = await inspectWindowsRunningSession(
          config,
          id,
        );
        if (restoring)
          throw new Error(`Cannot confirm the exact file of a restoring session: ${id}`);
        const saved = await findExactSaved(config, id, file);
        if ((managed || starting) && !running)
          throw new Error(`Cannot confirm the exact file of a starting session: ${id}`);
        const pane = running ?? (await startExactSession(config, saved, basis));
        if (pane.file !== saved.file || pane.cwd !== saved.cwd || pane.startup !== "ready")
          throw new Error(`Running session does not match the expected file and cwd: ${id}`);
        await management.assertLive(basis!);
        return pane;
      },
      "try",
    );
  return await withSessionAudit(config, async (lifetime) => {
    if ((await serverOption(config, "@pi-mux-restored")) !== lifetime.generation)
      throw new Error("Dedicated server has not completed startup restore");
    if (await serverOption(config, `@pi-mux-restoring-${id}`))
      throw new Error(`Cannot confirm the exact file of a restoring session: ${id}`);
    const { running, managed } = await inspectRunningSession(config, id, "audit");
    const saved = await findExactSaved(config, id, file);
    if (managed && !running)
      throw new Error(`Cannot confirm the exact file of a starting session: ${id}`);
    await verifyServerLifetime(config, lifetime, "exact session reopen");
    const pane = running ?? (await startExactSession(config, saved));
    if (pane.file !== saved.file || pane.cwd !== saved.cwd || pane.startup !== "ready")
      throw new Error(`Running session does not match the expected file and cwd: ${id}`);
    await verifyServerLifetime(config, lifetime, "exact session reopen");
    return pane;
  });
}

async function startExactSession(
  config: Config,
  saved: Session,
  basis?: WindowsManagementBasis,
): Promise<Pane> {
  const target = await createSession(config, saved, sessionName(saved.id), basis);
  if (!target) throw new Error(`Cannot confirm the exact file of a competing session: ${saved.id}`);
  const pane = await waitForSession(config, target, saved.id);
  if (pane.session !== target)
    throw new Error(`Cannot confirm the session created for the expected file: ${saved.id}`);
  return pane;
}

async function openSaved(
  config: Config,
  id: string,
  mode: "normal" | "temporary" = "normal",
  expected?: WindowsManagementBasis,
): Promise<Pane> {
  if (platform.windows) {
    const management = windowsManagement(config);
    await management
      .createLaunchRights(windowsClaimLock(management))
      .discardUnclaimed([conversationLaunchKey(id)]);
  }
  const resolution = await resolveSaved(config, id, undefined, expected);
  return await openResolvedSession(config, id, resolution, mode);
}

async function openResolvedSession(
  config: Config,
  id: string,
  { running, managed, saved, recovery, windowsBasis: resolutionBasis }: SavedSessionResolution,
  mode: "normal" | "temporary" = "normal",
  restoringBasis?: WindowsManagementBasis,
): Promise<Pane> {
  const basis = restoringBasis ?? resolutionBasis;
  if (basis) await windowsManagement(config).assertLive(basis);
  if (running) return running;
  if (managed) return await waitForSession(config, managed.session, id);
  const candidate = saved ?? recovery;
  if (!candidate) throw new Error(`Session not found (use the complete ID): ${id}`);
  const name = sessionName(id);
  const created = await createSession(
    config,
    { id, cwd: candidate.cwd, file: saved?.file, temporary: mode === "temporary" },
    name,
    basis,
    restoringBasis === undefined,
  );
  return await waitForSession(config, created ?? name, id);
}

async function createSession(
  config: Config,
  session: {
    id: string;
    cwd: string;
    file?: string;
    request?: string;
    temporary?: boolean;
    warm?: boolean;
  },
  name: string,
  windowsBasis?: WindowsManagementBasis,
  requireRestored = true,
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
    ...(session.warm ? { PI_TMUX_STARTUP_MODE: "warm" } : {}),
  };
  const selection = session.file ? ["--session", session.file] : ["--session-id", session.id];
  const command = [
    config.pi,
    ...selection,
    "-e",
    config.extension,
    ...(session.request === undefined
      ? ["--", `/${startupCommand}`]
      : ["--agent", "main", "--", session.request]),
  ];
  if (platform.windows) {
    const management = windowsManagement(config);
    const basis = windowsBasis ?? (await management.audit(PANE_FORMAT, { requireRestored })).basis;
    return await startWindowsLaunch(config, {
      keys: [conversationLaunchKey(session.id)],
      basis,
      name: `${name}-${launchToken.slice(0, 12)}`,
      cwd: session.cwd,
      environment: desired,
      command,
      requireRestored,
    });
  }
  const removed = await excludedGlobalEnvironment(config, desired);
  const launch = platform.newSessionLaunch(command, desired, removed);
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
      ...launch.environmentArgs,
      "--",
      ...(session.request === undefined
        ? platform.tmuxPaneCommand(launch.paneCommand)
        : [launch.paneCommand]),
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
    if (launch.transportKey)
      await tmux(config, ["set-environment", "-u", "-t", target, launch.transportKey]);
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
  const savedQueries = saved.flatMap(({ name, pane, session }) => {
    const target = platform.windows ? `=${name}:.${pane}` : pane;
    return [
      ["show-options", "-pqv", "-t", target, "@pi_session_state"],
      ["show-options", "-pqv", "-t", target, "@pi_session_state_pending"],
      temporarySessionQuery(session),
    ];
  });
  const commands = [
    ...savedQueries,
    ...unsaved.map(({ session }) => temporarySessionQuery(session)),
  ];
  const results = await listTmuxQueries(config, commands);
  const sessions = saved.map(({ id, cwd, file, session }, index) => {
    const queryIndex = index * 3;
    const metadata = results[queryIndex]!;
    const pending = results[queryIndex + 1]!;
    for (const result of [metadata, pending]) {
      if (result.exitCode !== 0)
        throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
    }
    const temporary = readTemporarySession(
      config,
      session,
      id,
      results[queryIndex + 2]!,
      "allow-missing",
    );
    return {
      cwd,
      session: {
        id,
        file,
        ...parseSessionMetadata(metadata.stdout, id, file),
        publishPending: parsePublishPending(pending.stdout, id),
        ...(temporary ? { temporary: true as const } : {}),
      } satisfies ListedSession,
    };
  });
  const empty = unsaved.map(({ id, cwd, file, session }, index) => {
    const result = results[savedQueries.length + index]!;
    const temporary = readTemporarySession(config, session, id, result, "allow-missing");
    return {
      cwd,
      session: {
        id,
        file,
        ...(temporary ? { temporary: true as const } : {}),
      } satisfies EmptySession,
    };
  });
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

async function listTmuxQueries(config: TmuxConfig, commands: string[][]) {
  const batch = platform.windows
    ? undefined
    : await tmuxQueries(config, commands).catch(() => undefined);
  if (batch !== undefined) return batch;
  return Promise.all(commands.map((command) => tmux(config, command, true)));
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

const SWITCH_TARGET_MISSING_EXIT_CODE = 2;
const SWITCH_CLIENT_MISSING_EXIT_CODE = 3;

class SwitchResolutionError extends Error {
  constructor(
    message: string,
    readonly exitCode:
      | typeof SWITCH_TARGET_MISSING_EXIT_CODE
      | typeof SWITCH_CLIENT_MISSING_EXIT_CODE,
  ) {
    super(message);
  }
}

async function clientsMatchingPid(clients: TmuxClient[], clientPid: number): Promise<TmuxClient[]> {
  const matchingPids = await platform.clientPidsFor(
    clientPid,
    clients.map(({ pid }) => pid),
  );
  return clients.filter(({ pid }) => matchingPids.includes(pid));
}

async function resolveClient(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<TmuxClient> {
  const clients = await tmuxClients(config);
  const matching = clientPid === undefined ? clients : await clientsMatchingPid(clients, clientPid);
  if (matching.length === 1) return matching[0]!;
  const message =
    clientPid === undefined
      ? `Expected one attached tmux client, found ${matching.length}`
      : `Cannot identify the tmux client for process ${clientPid}`;
  if (matching.length === 0)
    throw new SwitchResolutionError(message, SWITCH_CLIENT_MISSING_EXIT_CODE);
  throw new Error(message);
}

async function switchSession(
  config: TmuxConfig,
  id: string,
  clientPid: number | undefined,
): Promise<void> {
  const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  if (targets.length === 0)
    throw new SwitchResolutionError(
      `Session not found (use the complete ID): ${id}`,
      SWITCH_TARGET_MISSING_EXIT_CODE,
    );
  if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
  const client = await resolveClient(config, clientPid);
  await tmux(config, ["switch-client", "-c", client.name, "-t", `=${targets[0]!.name}`]);
}

async function switchWindowsNewClient(
  config: TmuxConfig,
  target: Pane,
  clientPid: number,
  management: WindowsManagement,
  basis: WindowsManagementBasis,
): Promise<void> {
  const audit = await management.audit(PANE_FORMAT);
  const targets = audit.panes.flatMap(({ peer, rows }) =>
    parseLivePaneRows(rows.join("\n"), "list")
      .filter((pane) => pane.id === target.id)
      .map((pane) => ({ pane, peer })),
  );
  const [match] = targets;
  if (
    !launchBasisStillLive(basis, audit.basis) ||
    targets.length !== 1 ||
    !match ||
    match.pane.name !== target.name ||
    match.peer.name !== target.name ||
    match.pane.pid !== target.pid
  )
    throw new Error("Cannot verify the Windows client switch destination");
  const client = await resolveClient(config, clientPid);
  const process = inspectWindowsProcess(client.pid);
  if (process.state !== "live") throw new Error("Cannot identify the Windows client process");
  const [pid, creationTime] = match.peer.identity.split(":") as [string, string];
  const server = { pid: Number(pid), creationTime };
  const source = audit.panes.find(({ peer }) => !peer.held && peer.name === client.session);
  if (!source) throw new Error("Cannot verify the Windows client switch source");
  const routed = {
    ...config,
    env: { ...config.env, TMUX: `${config.socket},${source.peer.port},0` },
  };
  await tmux(routed, ["switch-client", "-c", client.name, "-t", `=${target.name}`]);
  await waitForPsmuxClient(
    (args, timeout) => tmux({ ...config, timeout }, args, true),
    { clientPid: client.pid, name: target.name, serverPid: server.pid, instance: basis.instance },
    () =>
      [server, process.identity].every(
        (identity) => observeWindowsIdentity(identity, inspectWindowsProcess) === "present",
      ),
  );
}

async function displayedSessions(
  config: TmuxConfig,
  clientPid: number | undefined,
): Promise<DisplayedSession[]> {
  const clients = await tmuxClients(config);
  const matching = clientPid === undefined ? clients : await clientsMatchingPid(clients, clientPid);
  if (clientPid !== undefined && matching.length > 1)
    throw new Error(`Multiple tmux clients match process ${clientPid}`);
  if (matching.length === 0) return [];

  const displayedIn = new Set(matching.map(({ session }) => session));
  const panes = await livePanes(config, { displayedIn });
  const displayBySession = new Map(panes.map((pane) => [pane.name, pane]));
  return matching.flatMap(({ pid, session }) => {
    const pane = displayBySession.get(session);
    if (!pane) return [];
    return [{ clientPid: pid, id: pane.id, cwd: pane.cwd, file: pane.file, target: pane.name }];
  });
}

async function sendSessionMessage(
  config: TmuxConfig,
  id: string,
  text: string,
  waitSeconds: number | undefined,
): Promise<number> {
  try {
    const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
    if (targets.length === 0) throw new Error(`Session not found (use the complete ID): ${id}`);
    if (targets.length > 1) throw new Error(`Multiple pi processes are running for session ${id}`);
    const target = targets[0]!;
    const server = await serverLifetime(config);
    if (!server) throw new Error("Dedicated server is not running");
    const messageId = randomUUID();
    const optionName = `@pi-mux-msg-${messageId}`;
    const from = process.env.PI_SESSION_ID?.trim() || "external";
    const envelope = Buffer.from(
      JSON.stringify({ v: 1, id: messageId, from, at: new Date().toISOString(), text }),
      "utf8",
    ).toString("base64");
    const writeAndReadBack = guardedTmuxLine(
      target.pane,
      paneEntityGuard(server.pid, target.pane, target.panePid),
      [
        ["set-option", "-p", "-t", target.pane, optionName, envelope],
        ["show-options", "-pqv", "-t", target.pane, optionName],
      ],
      "PI_MUX_MESSAGE_TARGET_LOST",
    );
    const result = await tmux(config, ["source-file", "-"], false, `${writeAndReadBack}\n`);
    if (result.stdout.includes("PI_MUX_MESSAGE_TARGET_LOST"))
      throw new Error("Target pane no longer matches the conversation");
    if (result.stdout.trim() !== envelope)
      throw new Error("Cannot confirm the message option write");
    if (waitSeconds === undefined) return 0;
    const outcome = await waitForMessageConsumption(config, target.pane, optionName, waitSeconds);
    if (outcome === "consumed") {
      console.log("delivered");
      return 0;
    }
    if (outcome === "lost")
      throw new Error(`Target pane disappeared before consuming ${optionName}`);
    throw new Error(`Message option ${optionName} was not consumed within ${waitSeconds} seconds`);
  } catch (error) {
    throw new Error(`Cannot send message to session ${id}: ${errorMessage(error)}`);
  }
}

async function sendViewReceipt(
  config: TmuxConfig,
  id: string,
  receipt: ViewReceipt,
): Promise<void> {
  const targets = (await livePanes(config, "list")).filter((pane) => pane.id === id);
  const target = targets[0];
  if (!target || targets.length !== 1)
    throw new Error(`Cannot identify a single live session: ${id}`);
  if (
    realpathSync(target.file) !== receipt.file ||
    metadataFileIdentity(receipt.file) !== receipt.fileIdentity
  )
    throw new Error(`Session ${id} no longer points at the viewed history`);
  const server = await serverLifetime(config);
  if (!server) throw new Error("Dedicated server is not running");
  const option = `@pi-mux-view-${randomUUID()}`;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      sessionId: id,
      processPid: target.pid,
      file: receipt.file,
      fileIdentity: receipt.fileIdentity,
      responseId: receipt.responseId,
      viewedAt: receipt.viewedAt,
    }),
  ).toString("base64");
  if (payload.length > VIEW_RECEIPT_MAX_ENCODED_LENGTH)
    throw new Error(`View receipt is too large for session ${id}`);
  if (!/^%\d+$/.test(target.pane) || !BASE64_OPTION_VALUE.test(target.metadata))
    throw new Error(`Invalid pane identity for session ${id}`);
  const paneGuard = paneEntityGuard(server.pid, target.pane, target.panePid);
  const writeAndReadBack = guardedTmuxLine(
    target.pane,
    `#{&&:${paneGuard},#{==:#{@pi-tmux-session},${target.metadata}}}`,
    [
      ["set-option", "-p", "-t", target.pane, option, payload],
      ["show-options", "-pqv", "-t", target.pane, option],
    ],
  );
  const result = await tmux(config, ["source-file", "-"], false, `${writeAndReadBack}\n`);
  if (result.stdout.trim() !== payload) throw new Error(`Cannot queue view for session ${id}`);
  const outcome = await waitForMessageConsumption(
    config,
    target.pane,
    option,
    VIEW_RECEIPT_TIMEOUT_SECONDS,
  );
  if (outcome === "timeout") {
    const clear = guardedTmuxLine(target.pane, paneGuard, [
      ["set-option", "-pu", "-t", target.pane, option],
    ]);
    await tmux(config, ["source-file", "-"], true, `${clear}\n`);
  }
  if (outcome !== "consumed")
    throw new Error(`View receipt not consumed for session ${id}: ${outcome}`);
}

async function waitForMessageConsumption(
  config: TmuxConfig,
  pane: string,
  optionName: string,
  waitSeconds: number,
): Promise<"consumed" | "lost" | "timeout"> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await tmux(config, ["show-options", "-pqv", "-t", pane, optionName], true);
    if (result.exitCode !== 0)
      throw new Error(`Cannot inspect message option: ${result.stderr.trim()}`);
    if (!result.stdout.trim()) return (await paneExists(config, pane)) ? "consumed" : "lost";
    await Bun.sleep(SEND_WAIT_POLL_INTERVAL_MS);
  }
  return "timeout";
}

async function paneExists(config: TmuxConfig, pane: string): Promise<boolean> {
  const result = await tmux(config, ["list-panes", "-a", "-F", "#{pane_id}"], true);
  if (result.exitCode !== 0) {
    if (serverIsAbsent(config, result.stderr) || result.stderr.includes("no sessions"))
      return false;
    throw new Error(`Cannot inspect panes: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd().split("\n").includes(pane);
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
  purpose: "startup" | "list" | { displayedIn: ReadonlySet<string> } = "startup",
  auditedSessions?: ManagedSession[],
): Promise<Pane[]> {
  const format = auditedSessions
    ? `${PANE_FORMAT}\t#{==:#{TICKET_DISPATCH_ROLE},pi}\t#{!=:#{PI_TMUX_SESSION_ID},}\t#{@pi-mux-launch}`
    : PANE_FORMAT;
  const result = await tmux(config, ["list-panes", "-a", "-F", format], true);
  const rows = result.stdout.replace(/\n$/, "");
  if (auditedSessions) {
    const reportsEmpty =
      result.exitCode === 0
        ? !rows
        : /^(no sessions|no current target)$/.test(result.stderr.trim());
    if (reportsEmpty) {
      if (!(await tmux(config, ["list-sessions", "-F", "#{session_id}"])).stdout.trim()) return [];
      throw new Error("Cannot confirm an empty tmux pane inventory");
    }
  } else if (result.exitCode !== 0) {
    if (result.stderr.includes("no sessions") || result.stderr.includes("no current target"))
      return [];
    if (purpose !== "startup" && serverIsAbsent(config, result.stderr)) return [];
  }
  if (result.exitCode !== 0) throw new Error(`Cannot inspect pi sessions: ${result.stderr.trim()}`);
  return parseLivePaneRows(rows, purpose, auditedSessions);
}

function parseLivePaneRows(
  rows: string,
  purpose: "startup" | "list" | { displayedIn: ReadonlySet<string> },
  auditedSessions?: ManagedSession[],
): Pane[] {
  if (!rows) return [];
  return rows.split("\n").flatMap((line) => {
    const columns = line.split("\t");
    const [pane, session, name, encoded, pid, dead, windowActive, paneActive, ...audit] = columns;
    if (auditedSessions) {
      const hasValidPane = /^%\d+$/.test(pane ?? "") && /^\$\d+$/.test(session ?? "") && name;
      const [dispatcherPi, managedId, launch] = audit;
      const hasAuditFlags =
        audit.length === 3 &&
        [dead, dispatcherPi, managedId].every((flag) => flag === "0" || flag === "1");
      if (!hasValidPane || !hasAuditFlags) throw new Error("Invalid tmux pane inventory");
      if (dead === "0" && !encoded) {
        const managed = auditedSessions.find((entry) => entry.session === session);
        const hasUnidentifiedPi = (dispatcherPi === "1" || managedId === "1") && !managed;
        if (hasUnidentifiedPi || (launch && !launchMatchesManagedSession(launch, managed, pid)))
          throw new Error(`Cannot identify the starting pi in pane ${pane}`);
      }
    }
    if (!pane || !session || !name || !encoded || dead !== "0") return [];
    const active = windowActive === "1" && paneActive === "1";
    if (typeof purpose === "object" && (!active || !purpose.displayedIn.has(name))) return [];
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
        !(purpose !== "startup" && metadata.startup === undefined))
    )
      throw new Error(`Invalid pi session metadata in pane ${pane}`);
    if (metadata.processPid !== undefined) {
      if (!Number.isSafeInteger(metadata.processPid) || metadata.processPid <= 0)
        throw new Error(`Invalid pi session metadata in pane ${pane}`);
      if (
        platform.processAncestryAvailable &&
        !platform.processDescendsFrom(metadata.processPid, Number(pid))
      ) {
        if (auditedSessions) throw new Error(`Cannot confirm the pi process in pane ${pane}`);
        return [];
      }
    }
    return [
      {
        pane,
        session,
        name,
        active,
        pid: metadata.processPid ?? Number(pid),
        panePid: Number(pid),
        id: metadata.id,
        cwd: metadata.cwd,
        file: metadata.file,
        startup: metadata.startup,
        warm: metadata.warm === true,
        metadata: encoded,
      },
    ];
  });
}

function launchMatchesManagedSession(
  encoded: string,
  managed: ManagedSession | undefined,
  pid: string | undefined,
): boolean {
  if (!managed || !pid) return false;
  return matchesLaunch(encoded, managed.id, Number(pid), launchRecordToken(encoded));
}

function parseSessionMetadata(
  encoded: string | undefined,
  id: string,
  file: string,
): Pick<ListedSession, "state" | "title" | "lastRun"> {
  const published = parseSessionOption(encoded, id);
  const state = isSessionState(published?.state) ? published.state : null;
  const title = typeof published?.title === "string" ? published.title : resolveSessionTitle(file);
  const lastRun = parseLastRun(published?.lastRun);
  return { state, title, ...(lastRun ? { lastRun } : {}) };
}

function parseSessionState(encoded: string | undefined, id: string): SessionState | null {
  const state = parseSessionOption(encoded, id)?.state;
  return isSessionState(state) ? state : null;
}

function isSessionState(state: unknown): state is SessionState {
  return state === "running" || state === "waiting-approval" || state === "waiting-user";
}

function parsePublishPending(encoded: string | undefined, id: string): PublishPending | null {
  if (!encoded) return null;
  let pending: { version?: unknown; sessionId?: unknown; attemptAt?: unknown } | null;
  try {
    pending = JSON.parse(encoded);
  } catch {
    return null;
  }
  const attemptAt = isRecord(pending) ? pending.attemptAt : undefined;
  if (
    pending?.version !== 1 ||
    pending.sessionId !== id ||
    typeof attemptAt !== "number" ||
    !Number.isSafeInteger(attemptAt) ||
    attemptAt <= 0
  )
    return null;
  return { attemptAt };
}

function parseSessionOption(
  encoded: string | undefined,
  id: string,
): Record<string, unknown> | undefined {
  if (!encoded) return undefined;
  let metadata: unknown;
  try {
    metadata = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(metadata) || metadata.version !== 1 || metadata.sessionId !== id) return undefined;
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

async function configuredSessionRoot(config: SavedSessionConfig): Promise<string | undefined> {
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
  config: SavedSessionConfig,
  groups?: string[],
): Promise<SavedSessionLayers> {
  const customRoot = await configuredSessionRoot(config);
  if (customRoot) return { customRoot, layers: [{ directories: [customRoot], archived: false }] };
  const directories = groups ?? (await cwdGroupDirectories(config));
  return {
    customRoot: undefined,
    layers: [
      { directories, archived: false },
      { directories: directories.map((group) => join(group, "archive")), archived: true },
    ],
  };
}

async function cwdGroupDirectories(config: SavedSessionConfig): Promise<string[]> {
  const root = join(config.agentDir, "sessions");
  return (await sessionDirectoryEntries(root))
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("--") && entry.name.endsWith("--"),
    )
    .map((entry) => join(root, entry.name));
}

async function findExactSaved(config: TmuxConfig, id: string, file: string): Promise<Session> {
  const customRoot = await configuredSessionRoot(config);
  const roots = await cwdGroupDirectories(config);
  if (customRoot && existsSync(customRoot)) roots.push(customRoot);
  const allowed = roots.some((root) => {
    const directory = realpathSync(root);
    return dirname(file) === directory || dirname(file) === join(directory, "archive");
  });
  if (!allowed)
    throw new Error(`Expected file is outside the supported session directories: ${file}`);
  if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== file)
    throw new Error(`Expected session file is not a canonical regular file: ${file}`);
  const header = readHeader(file);
  if (
    header?.type !== "session" ||
    header.id !== id ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    header.cwd.includes("\0")
  )
    throw new Error(`Expected file has an invalid or mismatched session header: ${file}`);
  const cwd = realpathSync(header.cwd);
  if (!statSync(cwd).isDirectory())
    throw new Error(`Session working directory is not a directory: ${cwd}`);
  return { id, file, cwd };
}

async function findSaved(
  config: TmuxConfig,
  id: string,
  purpose: "open" | "restore" = "open",
): Promise<Session | undefined> {
  const { layers } = await savedSessionLayers(config);
  return findSavedInLayers(layers, id, purpose);
}

async function readSessionMetadata(config: SavedSessionConfig, id: string) {
  try {
    return await readSessionMetadataOnce(config, id);
  } catch (error) {
    if (!(error instanceof SessionPathChangedError)) throw error;
    return await readSessionMetadataOnce(config, id);
  }
}

async function readSessionMetadataOnce(config: SavedSessionConfig, id: string) {
  const { customRoot, layers } = await savedSessionLayers(config);
  const scope = customRoot ?? join(config.agentDir, "sessions");
  const directories = layers.flatMap((layer) => layer.directories).sort();
  const directoryRevision = createHash("sha256")
    .update(
      JSON.stringify(
        directories.map((path) => {
          const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
          return [path, stat && [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":")];
        }),
      ),
    )
    .digest("hex");
  return new SessionMetadataCache(id, scope, directoryRevision).read(
    async (unresolvedFiles) => (await findSavedInLayers(layers, id, "open", unresolvedFiles))?.file,
  );
}

async function findSavedInLayers(
  layers: SessionDirectoryLayer[],
  id: string,
  purpose: "open" | "restore",
  unresolvedFiles?: UnresolvedFile[],
): Promise<Session | undefined> {
  for (const { directories } of layers) {
    const listed = (await Promise.all(directories.map(sessionFiles))).flat();
    const files = new Set(
      listed.flatMap((file) => {
        const canonical = unresolvedFiles
          ? ifPresent(() => realpathSync(file))
          : realpathSync(file);
        return canonical === undefined ? [] : [canonical];
      }),
    );
    const matches = [...files].flatMap((file) => {
      const revision = unresolvedFiles ? ifPresent(() => metadataFileRevision(file)) : undefined;
      const header = unresolvedFiles
        ? ifPresent(() => readHeader(file, "verified"))
        : readHeader(file);
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        !SESSION_ID_PATTERN.test(header.id) ||
        typeof header.cwd !== "string" ||
        !isAbsolute(header.cwd)
      ) {
        if (purpose === "restore" || header?.id === id)
          throw new Error(`Invalid session header: ${file}`);
        if (revision !== undefined) unresolvedFiles?.push({ file, revision });
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

function ifPresent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw error;
  }
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

function readHeader(path: string, mode?: "verified"): Record<string, unknown> | undefined {
  const fd = openSync(
    path,
    mode === "verified" ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW : "r",
  );
  try {
    return mode === "verified" && !fstatSync(fd).isFile() ? undefined : readSessionHeader(fd);
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
  const clientFlags = config.noStart && !platform.windows ? ["-N"] : [];
  const child = Bun.spawn(
    [config.tmux, "-S", config.socket, "-f", config.tmuxConfig, ...clientFlags, ...args],
    {
      env: config.env,
      timeout: config.timeout,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) throw new Error(`tmux ${args[0]} failed: ${stderr.trim()}`);
  return platform.windows
    ? { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode }
    : { stdout, stderr, exitCode };
}

if (import.meta.main) process.exitCode = await main();
