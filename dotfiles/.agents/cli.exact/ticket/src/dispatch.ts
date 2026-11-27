import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdirSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Database, SQLiteError } from "bun:sqlite";
import dispatchPromptPath from "../dispatch-prompt.md" with { type: "file" };
import lockedPromptPath from "../dispatch-locked-prompt.md" with { type: "file" };
import { LockHistory, type LockHistoryOwner, type LockHistoryTarget } from "./lock-history";
import {
  requireWindowsManagement,
  runWindowsInspection,
  windowsDispatchDirectory,
  windowsPsmuxEnvironment,
  WindowsWorkerRights,
  windowsWorkerSocket,
  WORKER_TOKEN_ENV,
} from "./windows-dispatch";

const OPTION_KEYS = ["--max", "--status"];
const INSPECT_TIMEOUT_MS = 8_000;
const MAX_LOCKED_LAUNCH_ATTEMPTS = 2;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
type DispatchStatus = "open" | "locked";
type OwnerInspection = "present" | "unknown" | "busy" | "absent";

function includesStatus(options: DispatchOptions, status: DispatchStatus): boolean {
  return (options.statuses ?? ["open"]).includes(status);
}

const SESSION_NAME_PREFIX = "handle_";

const DEFAULT_TICK_MS = 3_000;

export interface DispatchOptions {
  max: number;
  statuses?: DispatchStatus[];
}

export const DISPATCH_USAGE =
  "ticket dispatch list\n       ticket dispatch [-p|--project <project>] [-a|--all] [--max N] [--status <open|locked>]...\n       ticket dispatch start [-p|--project <project>] [-a|--all] [--max N] [--status <open|locked>]...\n       ticket dispatch stop [-p|--project <project>] [-a|--all]\n       ticket dispatch one --project <project> <id>";

function tickMs(): number {
  const override = Number(process.env.TICKET_TEST_TICK_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TICK_MS;
}

export function sessionName(prefix: string, id: string, all = false): string {
  if (!all) return prefix + id.split(".").join("_");
  const [project, ticketId] = splitTicketKey(id);
  return `${prefix}${Buffer.from(project).toString("hex")}_${ticketId.split(".").join("_")}`;
}

function splitTicketKey(key: string): [string, string] {
  const separator = key.indexOf("/");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function projectCwd(project: string): string {
  return join(homedir(), "projects", project);
}

async function validateCwds(
  tickets: TicketSnapshot[],
  isCandidate: (ticket: TicketSnapshot) => boolean,
  log: (line: string) => void,
): Promise<Set<string>> {
  const skipped = new Set<string>();
  const projects = new Set(
    tickets.filter(isCandidate).map((ticket) => splitTicketKey(ticket.id)[0]),
  );
  for (const project of projects) {
    const cwd = projectCwd(project);
    let entry;
    try {
      entry = await stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.add(project);
        log(`skipped ${project}: cwd not found: ${cwd}`);
        continue;
      }
      throw error;
    }
    if (!entry.isDirectory()) throw new Error(`not a directory: ${cwd}`);
    await access(cwd, constants.X_OK);
  }
  return skipped;
}

export function buildPrompt(template: string, id: string): string {
  return template.split("{{ TICKET_ID }}").join(id);
}

export interface TicketSnapshot {
  id: string;
  status: string;
  actionable: boolean;
}

export type LoadSnapshot = () => Promise<TicketSnapshot[]>;

export interface PlanInput {
  tickets: TicketSnapshot[];
  skipped?: ReadonlySet<string>;
  started: ReadonlySet<string>;
  running: ReadonlyMap<string, string>;
  max: number;
  hasSession(session: string): boolean;
}

export interface DoneEntry {
  id: string;
  session: string;
  status: string;
}

export interface IncompleteEntry {
  id: string;
  session: string;
  status: string | null;
}

export interface Plan {
  done: DoneEntry[];
  incomplete: IncompleteEntry[];
  launches: string[];
  finished: boolean;
}

export function planTick(input: PlanInput): Plan {
  const done: DoneEntry[] = [];
  const incomplete: IncompleteEntry[] = [];
  const byId = new Map(input.tickets.map((ticket) => [ticket.id, ticket]));

  for (const [session, id] of input.running) {
    const status = byId.get(id)?.status ?? null;
    if (
      status === "closed" ||
      status === "cancelled" ||
      status === "blocked" ||
      status === "draft"
    ) {
      done.push({ id, session, status });
    } else if (!input.hasSession(session)) {
      incomplete.push({ id, session, status });
    }
  }

  const remainingRunning = input.running.size - done.length - incomplete.length;
  const runningIds = new Set(input.running.values());
  const candidates = input.tickets
    .filter(
      (ticket) => ticket.actionable && !input.started.has(ticket.id) && !runningIds.has(ticket.id),
    )
    .filter((ticket) => !input.skipped || !input.skipped.has(splitTicketKey(ticket.id)[0]));
  const launches = candidates
    .slice(0, Math.max(0, input.max - remainingRunning))
    .map((ticket) => ticket.id);

  return {
    done,
    incomplete,
    launches,
    finished: remainingRunning === 0 && launches.length === 0,
  };
}

export function parseDispatchArgs(argv: string[]): {
  action?: "start" | "stop" | "list" | "one";
  project?: string;
  ticketId?: string;
  all?: boolean;
  options?: DispatchOptions;
  error?: string;
} {
  const [subcommand] = argv;
  const action =
    subcommand === "stop" || subcommand === "list" || subcommand === "one" ? subcommand : "start";
  if (subcommand === action) argv = argv.slice(1);
  const given = new Map<string, string>();
  const statuses = new Set<DispatchStatus>();
  let project: string | undefined;
  let ticketId: string | undefined;
  let all = false;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (action === "list") return { error: `unknown option: ${arg}` };
    const isProject = arg === "--project" || (action !== "one" && arg === "-p");
    const isTicketId = action === "one" && (optionsEnded || !arg.startsWith("-"));
    if (isTicketId && ticketId === undefined) ticketId = arg;
    else if (optionsEnded) return { error: "positional arguments are not supported" };
    else if (arg === "--") optionsEnded = true;
    else if (action !== "one" && (arg === "-a" || arg === "--all")) all = true;
    else if (isProject || (action === "start" && OPTION_KEYS.includes(arg))) {
      const value = argv[++index];
      if (
        value === undefined ||
        value.startsWith("--") ||
        value === "-p" ||
        value === "-a" ||
        (isProject && value.startsWith("-"))
      )
        return { error: `missing value for ${arg}` };
      if (isProject) {
        if (action === "one" && project !== undefined) return { error: "duplicate --project" };
        project = value;
      } else if (arg === "--status") {
        if (value !== "open" && value !== "locked")
          return { error: "--status must be open or locked" };
        statuses.add(value);
      } else given.set(arg, value);
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else return { error: "positional arguments are not supported" };
  }
  if (action === "one") {
    if (project === undefined || !ticketId)
      return { error: "one requires --project and a ticket ID" };
    return { action, project, ticketId };
  }
  if (action !== "start") return { action, project, all };
  const max = given.has("--max") ? Number(given.get("--max")) : 5;
  if (!Number.isInteger(max) || max < 1) return { error: "--max must be an integer >= 1" };
  return {
    action: "start",
    project,
    all,
    options: statuses.size === 0 ? { max } : { max, statuses: [...statuses] },
  };
}

function timestamp(date = new Date()): string {
  function pad(value: number): string {
    return String(value).padStart(2, "0");
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export function tmux(socket: string, args: string[]) {
  const result =
    process.platform === "win32"
      ? spawnSync("psmux.exe", ["-S", socket, ...args], {
          encoding: "utf8",
          env: windowsPsmuxEnvironment(),
          timeout: INSPECT_TIMEOUT_MS,
          windowsHide: true,
        })
      : spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

const PROJECT_ENV = "TICKET_DISPATCH_PROJECT";
const ROLE_ENV = "TICKET_DISPATCH_ROLE";
const ID_ENV = "TICKET_DISPATCH_ID";

function inspectOwner(id: string, cwd: string): OwnerInspection {
  const result = spawnSync("pi-mux", ["inspect", id], {
    cwd,
    encoding: "utf8",
    timeout: INSPECT_TIMEOUT_MS,
  });
  if (result.status === 75 && !result.error) return "busy";
  if (result.status !== 0 || result.error) return "unknown";
  try {
    const value = JSON.parse(result.stdout);
    if (value?.state === "present") return "present";
    if (
      value?.state === "absent" &&
      (value.file === null ||
        (typeof value.file === "string" && isAbsolute(value.file) && !value.file.includes("\0")))
    )
      return "absent";
  } catch {
    return "unknown";
  }
  return "unknown";
}

export function dispatchSocket(): string {
  return (
    process.env.TICKET_TEST_TMUX_SOCKET ??
    (process.platform === "win32"
      ? join(homedir(), ".local", "state", "pi-tmux", "server.sock")
      : "/run/user/1000/pi-tmux/server.sock")
  );
}

export function dispatcherName(project: string | null): string {
  return project === null
    ? "ticket_dispatch_all"
    : `ticket_dispatch_${Buffer.from(project).toString("hex")}`;
}

function sessionEnv(socket: string, target: string, key: string): string | undefined {
  const result = tmux(socket, ["show-environment", "-t", target, key]);
  if (!result.ok || !result.stdout.startsWith(`${key}=`)) return undefined;
  if (process.platform === "win32")
    return result.stdout.slice(key.length + 1).replace(/\r?\n$/, "");
  return result.stdout.slice(key.length + 1, -1);
}

function ownsDispatcher(socket: string, name: string, project: string | null): boolean {
  const target = `=${name}`;
  return (
    sessionEnv(socket, target, PROJECT_ENV) === (project ?? "") &&
    sessionEnv(socket, target, ROLE_ENV) === "dispatcher"
  );
}

function sessionEnvArgs(project: string | null, role: string): string[] {
  const entries = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TICKET_TEST_TMUX_SOCKET: process.env.TICKET_TEST_TMUX_SOCKET,
    TICKET_TEST_TICK_MS: process.env.TICKET_TEST_TICK_MS,
    [PROJECT_ENV]: project ?? "",
    [ROLE_ENV]: role,
  };
  return Object.entries(entries).flatMap(([key, value]) =>
    value === undefined ? [] : ["-e", `${key}=${value}`],
  );
}

export function workerCommand(entry: string, argv: string[], project: string | null): string[] {
  const compiled =
    entry.startsWith("/$bunfs/") ||
    (process.platform === "win32" && /^[a-z]:[\\/]~bun[\\/]/i.test(entry));
  const executable = compiled ? [process.execPath] : [process.execPath, entry];
  const workerProject = project ?? (process.platform === "win32" ? "-" : "");
  return [...executable, "__ticket_dispatch_worker", workerProject, ...argv];
}

const DISPATCH_LOCK_TIMEOUT_MS = 4_000;
const DISPATCH_LOCK_RETRY_MS = 10;

class DispatchLockBusy extends Error {}

async function withDispatcherLock<T>(socket: string, operation: () => Promise<T>): Promise<T> {
  let path: string;
  if (process.platform === "win32") {
    const directory = windowsDispatchDirectory(socket);
    mkdirSync(directory, { recursive: true });
    path = join(directory, "lifecycle.sqlite");
  } else {
    const key = createHash("sha256").update(socket).digest("hex");
    path = `/tmp/ticket-dispatch-${key}.sqlite`;
  }
  const database = new Database(path);
  const deadline = Date.now() + DISPATCH_LOCK_TIMEOUT_MS;
  try {
    while (true) {
      try {
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline)
          throw new DispatchLockBusy(`timed out waiting for dispatcher lock: ${socket}`);
        await Bun.sleep(DISPATCH_LOCK_RETRY_MS);
      }
    }
    return await operation();
  } finally {
    database.close();
  }
}

function sessionNames(socket: string): string[] {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_name}"]);
  return result.ok ? result.stdout.trimEnd().split("\n") : [];
}

interface StartDispatcherInput {
  project: string | null;
  loadSnapshot: LoadSnapshot;
  options?: DispatchOptions;
  command: string[];
}

async function startWindowsDispatcher(socket: string, input: StartDispatcherInput): Promise<void> {
  const options = input.options ?? { max: 5 };
  const generation = await requireWindowsManagement(socket);
  const { project } = input;
  const name = dispatcherName(project);
  await withDispatcherLock(socket, async () => {
    if ((await requireWindowsManagement(socket)) !== generation)
      throw new Error("Windows pi-mux management changed before dispatcher start");
    const openEnabled = includesStatus(options, "open");
    const lockedEnabled = includesStatus(options, "locked");
    if (openEnabled) await Bun.file(dispatchPromptPath).text();
    if (lockedEnabled) await Bun.file(lockedPromptPath).text();
    const tickets = await input.loadSnapshot();
    if (project === null) {
      const sessions = await readWindowsDispatchInventory(socket);
      const started = new Set(
        sessions.map(({ project, ticketId }) => `${project}/${ticketId}`.toLowerCase()),
      );
      await validateCwds(
        tickets,
        (ticket) =>
          !started.has(ticket.id.toLowerCase()) &&
          ((openEnabled && ticket.actionable) ||
            (lockedEnabled && lockedTarget(ticket, null, process.cwd()) !== undefined)),
        console.log,
      );
    }
    const rights = new WindowsWorkerRights(windowsDispatchDirectory(socket));
    const restarted = await rights.start(socket, { project, name, generation }, input.command);
    console.log(`dispatcher ${restarted ? "restarted" : "started"}: ${name}`);
  });
}

export async function startDispatcher(input: StartDispatcherInput): Promise<void> {
  const { project } = input;
  const socket = dispatchSocket();
  if (process.platform === "win32") return startWindowsDispatcher(socket, input);
  await withDispatcherLock(socket, async () => {
    const name = dispatcherName(project);
    for (const other of sessionNames(socket)) {
      if (other === name) continue;
      if (sessionEnv(socket, `=${other}`, ROLE_ENV) !== "dispatcher") continue;
      const owner = sessionEnv(socket, `=${other}`, PROJECT_ENV);
      if (owner !== undefined && (project === null || owner === ""))
        throw new Error(`overlapping dispatcher already running: ${other}`);
    }
    let restarted = false;
    if (ownsDispatcher(socket, name, project)) {
      const killed = tmux(socket, ["kill-session", "-t", `=${name}`]);
      if (!killed.ok && ownsDispatcher(socket, name, project))
        throw new Error(`dispatcher restart failed for ${name}: ${killed.stderr.trim()}`);
      restarted = true;
    }
    const options = input.options ?? { max: 5 };
    const lockedEnabled = includesStatus(options, "locked");
    if (includesStatus(options, "open")) await Bun.file(dispatchPromptPath).text();
    if (lockedEnabled) await Bun.file(lockedPromptPath).text();
    const tickets = await input.loadSnapshot();
    if (project === null) {
      const started = new Set(readPiSessions(socket, project).values());
      const openEnabled = includesStatus(options, "open");
      await validateCwds(
        tickets,
        (ticket) =>
          !started.has(ticket.id) &&
          ((openEnabled && ticket.actionable) ||
            (lockedEnabled && lockedTarget(ticket, null, process.cwd()) !== undefined)),
        console.log,
      );
    }
    const sessionDirKey = "PI_CODING_AGENT_SESSION_DIR";
    const sessionDir = process.env[sessionDirKey];
    const sessionDirSetup =
      sessionDir === undefined
        ? `unset ${sessionDirKey}`
        : `export ${sessionDirKey}=${shQuote(sessionDir)}`;
    const workerCommand = `exec ${input.command.map(shQuote).join(" ")}`;
    const paneCommand = lockedEnabled
      ? ["/bin/sh", "-c", `${sessionDirSetup}; ${workerCommand}`]
      : [workerCommand];
    const result = tmux(socket, [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      process.cwd(),
      ...sessionEnvArgs(project, "dispatcher"),
      ...(lockedEnabled
        ? [
            "-e",
            `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? ""}`,
            "-e",
            `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR ?? ""}`,
          ]
        : []),
      ...paneCommand,
    ]);
    if (!result.ok) throw new Error(`dispatcher start failed for ${name}: ${result.stderr.trim()}`);
    console.log(`dispatcher ${restarted ? "restarted" : "started"}: ${name}`);
  });
}

export async function stopDispatcher(project: string | null): Promise<void> {
  const socket = dispatchSocket();
  await withDispatcherLock(socket, async () => {
    const name = dispatcherName(project);
    if (process.platform === "win32") {
      const stopped = await new WindowsWorkerRights(windowsDispatchDirectory(socket)).stop(
        socket,
        project,
      );
      console.log(`dispatcher ${stopped ? "stopped" : "already stopped"}: ${name}`);
      return;
    }
    if (!ownsDispatcher(socket, name, project)) {
      console.log(`dispatcher already stopped: ${name}`);
      return;
    }
    const result = tmux(socket, ["kill-session", "-t", `=${name}`]);
    if (!result.ok && ownsDispatcher(socket, name, project))
      throw new Error(`dispatcher stop failed for ${name}: ${result.stderr.trim()}`);
    console.log(`dispatcher stopped: ${name}`);
  });
}

const DISPATCH_METADATA_KEYS = new Set([ROLE_ENV, PROJECT_ENV, ID_ENV]);
const VISIBLE_ENV_ENTRY = "#{&&:#{==:#{environ_hidden},0},#{==:#{environ_removed},0}}";
const DISPATCH_ENV_ENTRY = `#{m/r:^(${[...DISPATCH_METADATA_KEYS].join("|")})$,#{environ_name}}`;
const INVENTORY_VERSION = "v1";
const ENV_LOOP_MARKER = `#{V/c:#{?#{==:#{environ_name},HOME},${INVENTORY_VERSION},}}`;
const INVENTORY_SEPARATOR = "|";
const UNFRAMED_FIELD = "!";
const DISPATCH_ENV_FIELD = `#{?#{m/r:[${INVENTORY_SEPARATOR}[:cntrl:]],#{environ_value}},${UNFRAMED_FIELD},#{environ_name}=#{environ_value}}`;
const PI_SESSIONS_FORMAT = `#{session_id}${INVENTORY_SEPARATOR}${ENV_LOOP_MARKER}#{V/s:#{?#{&&:${VISIBLE_ENV_ENTRY},${DISPATCH_ENV_ENTRY}},${INVENTORY_SEPARATOR}${DISPATCH_ENV_FIELD},}}`;

function readPiSessions(socket: string, project: string | null): Map<string, string> {
  const result = tmux(socket, ["list-sessions", "-F", PI_SESSIONS_FORMAT]);
  if (!result.ok && isMissingTmuxServer(result.stderr)) return new Map();
  const inventory = result.ok ? parsePiSessionInventory(result.stdout) : undefined;
  const sessions = new Map<string, string>();
  for (const [session, metadata] of inventory ?? readPiSessionIds(socket)) {
    function readMetadata(key: string): string | undefined {
      return metadata ? metadata.get(key) : sessionEnv(socket, session, key);
    }
    if (readMetadata(ROLE_ENV) !== "pi") continue;
    const owner = readMetadata(PROJECT_ENV);
    if (!owner || (project !== null && owner !== project)) continue;
    const id = readMetadata(ID_ENV);
    if (id) sessions.set(session, project === null ? `${owner}/${id}` : id);
  }
  return sessions;
}

function isMissingTmuxServer(stderr: string): boolean {
  return /^no server running on |^error connecting to .*\(No such file or directory\)/.test(stderr);
}

type PiSessionInventory = Map<string, Map<string, string> | undefined>;

function parsePiSessionInventory(stdout: string): PiSessionInventory | undefined {
  const lines = stdout.split("\n");
  if (lines.pop() !== "") return undefined;
  const inventory: PiSessionInventory = new Map();
  for (const line of lines) {
    const [session, version, ...fields] = line.split(INVENTORY_SEPARATOR);
    if (
      !session ||
      !/^\$\d+$/.test(session) ||
      version !== INVENTORY_VERSION ||
      inventory.has(session)
    )
      return undefined;
    const metadata = new Map<string, string>();
    for (const field of fields) {
      if (field === UNFRAMED_FIELD) continue;
      const equals = field.indexOf("=");
      const key = field.slice(0, equals);
      if (equals < 0 || !DISPATCH_METADATA_KEYS.has(key) || metadata.has(key)) return undefined;
      metadata.set(key, field.slice(equals + 1));
    }
    inventory.set(session, fields.includes(UNFRAMED_FIELD) ? undefined : metadata);
  }
  return inventory;
}

function readPiSessionIds(socket: string): PiSessionInventory {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_id}"]);
  if (!result.ok) {
    if (isMissingTmuxServer(result.stderr)) return new Map();
    throw new Error(`cannot list dispatch sessions: ${result.stderr.trim()}`);
  }
  return new Map(
    result.stdout
      .trimEnd()
      .split("\n")
      .map((session) => [session, undefined]),
  );
}

type DispatchSession = { name: string; project: string; ticketId: string; created: number };

export class DispatchInventoryUnavailable extends Error {}

export function parseWindowsDispatchInventory(stdout: string): DispatchSession[] {
  const data: unknown = JSON.parse(stdout);
  if (!data || typeof data !== "object" || !("sessions" in data) || !Array.isArray(data.sessions))
    throw new Error("Malformed pi-mux dispatch inventory");
  const names = new Set<string>();
  return data.sessions.map((value: Partial<DispatchSession> | null) => {
    if (
      !value ||
      typeof value.name !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(value.name) ||
      typeof value.project !== "string" ||
      !value.project ||
      /[\\/\0]/.test(value.project) ||
      value.project === "." ||
      value.project === ".." ||
      typeof value.ticketId !== "string" ||
      !/^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value.ticketId) ||
      typeof value.created !== "number" ||
      !Number.isSafeInteger(value.created) ||
      value.created <= 0 ||
      names.has(value.name)
    )
      throw new Error("Malformed or duplicate pi-mux dispatch inventory entry");
    const { name, project, ticketId, created } = value;
    names.add(name);
    return { name, project, ticketId, created };
  });
}

async function readWindowsDispatchInventory(socket: string): Promise<DispatchSession[]> {
  try {
    const result = await runWindowsInspection(["--dispatch-inventory", socket], INSPECT_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.stderr.trim())
      throw new Error(result.stderr.trim() || "pi-mux rejected inventory request");
    return parseWindowsDispatchInventory(result.stdout);
  } catch (error) {
    throw new DispatchInventoryUnavailable(
      "cannot verify Windows dispatch inventory: " + (error as Error).message,
    );
  }
}

function windowsPiSessions(socket: string, project: string | null) {
  const accepted = new Map<string, { id: string; created?: number }>();
  return {
    launched(name: string, id: string): string {
      accepted.set(name, { id });
      return name;
    },
    async read(snapshot: TicketSnapshot[]): Promise<ReadonlyMap<string, string>> {
      const rows = await readWindowsDispatchInventory(socket);
      const ticketIds = new Map(snapshot.map(({ id }) => [id.toLowerCase(), id]));
      const sessions = new Map<string, string>();
      for (const { name, project: owner, ticketId, created } of rows) {
        if (project !== null && project.toLowerCase() !== owner.toLowerCase()) continue;
        const observedId = project === null ? `${owner}/${ticketId}` : ticketId;
        const id = ticketIds.get(observedId.toLowerCase()) ?? observedId;
        const launch = accepted.get(name);
        if (launch?.id === id) launch.created ??= created;
        const identity =
          launch?.id === id && launch.created === created ? name : JSON.stringify([name, created]);
        sessions.set(identity, id);
      }
      for (const name of accepted.keys()) if (!sessions.has(name)) accepted.delete(name);
      return sessions;
    },
  };
}

export function hasSession(socket: string, name: string): boolean {
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

export interface DispatcherEntry {
  project: string | null;
  name: string;
  created: number;
}

export function sortDispatchers(entries: DispatcherEntry[]): DispatcherEntry[] {
  return [...entries].sort((left, right) => {
    if (left.project === null) return right.project === null ? 0 : -1;
    if (right.project === null) return 1;
    return left.project < right.project ? -1 : left.project > right.project ? 1 : 0;
  });
}

export function formatDispatchers(entries: DispatcherEntry[]): string {
  const projectWidth = Math.max(...entries.map((entry) => (entry.project ?? "(all)").length));
  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
  return entries
    .map((entry) =>
      [
        (entry.project ?? "(all)").padEnd(projectWidth),
        entry.name.padEnd(nameWidth),
        timestamp(new Date(entry.created * 1000)),
      ].join("  "),
    )
    .join("\n");
}

export function listDispatchers(socket: string): DispatcherEntry[] {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_name}\t#{session_created}"]);
  if (!result.ok) return [];
  const entries: DispatcherEntry[] = [];
  for (const line of result.stdout.trimEnd().split("\n")) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const name = line.slice(0, separator);
    const created = Number(line.slice(separator + 1));
    if (sessionEnv(socket, `=${name}`, ROLE_ENV) !== "dispatcher") continue;
    const owner = sessionEnv(socket, `=${name}`, PROJECT_ENV);
    if (owner === undefined || !Number.isFinite(created)) continue;
    entries.push({ project: owner === "" ? null : owner, name, created });
  }
  return sortDispatchers(entries);
}

export async function listCurrentDispatchers(socket: string): Promise<DispatcherEntry[]> {
  if (process.platform !== "win32") return listDispatchers(socket);
  return await withDispatcherLock(socket, async () => {
    const rights = new WindowsWorkerRights(windowsDispatchDirectory(socket));
    return sortDispatchers(await rights.list(socket));
  });
}

export async function dispatchWorker(
  options: DispatchOptions,
  loadSnapshot: LoadSnapshot,
  project: string | null,
): Promise<void> {
  if (process.platform !== "win32") return dispatch(options, loadSnapshot, project);
  const socket = windowsWorkerSocket();
  if (!socket) throw new Error("Missing Windows dispatcher worker socket");
  const rights = new WindowsWorkerRights(windowsDispatchDirectory(socket));
  await rights.runWorker(socket, project, process.env[WORKER_TOKEN_ENV] ?? "", () =>
    dispatch(options, loadSnapshot, project, socket),
  );
}

interface LockedAssignment {
  project: string;
  ticketId: string;
  ownerId: string;
}

function lockedTarget(
  ticket: TicketSnapshot,
  scope: string | null | undefined,
  cwd: string,
): LockHistoryTarget | undefined {
  if (ticket.status !== "locked") return undefined;
  const [project, ticketId] = scope === null ? splitTicketKey(ticket.id) : [scope, ticket.id];
  if (
    !project ||
    project.startsWith("-") ||
    !/^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(ticketId)
  )
    return undefined;
  return { project, ticketId, cwd: scope === null ? projectCwd(project) : cwd };
}

async function readTicketRevision(target: LockHistoryTarget): Promise<string | undefined> {
  try {
    const path = join(homedir(), ".agents", "tickets", target.project, `${target.ticketId}.md`);
    const entry = await stat(path, { bigint: true });
    if (entry.isFile()) return `${entry.dev}:${entry.ino}:${entry.mtimeNs}:${entry.ctimeNs}`;
  } catch {
    return undefined;
  }
}

interface PreparedLock {
  target: LockHistoryTarget;
  revision: string;
  owner: LockHistoryOwner;
  inspection: OwnerInspection;
  isOwnerFileCurrent(): Promise<boolean>;
}

type OwnerProbe = PreparedLock | { skip: string; retry?: true };

async function waitForHistory<T>(history: Promise<T>, ms: number): Promise<T | undefined> {
  const { promise: deadline, resolve } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => resolve(undefined), ms);
  try {
    return await Promise.race([history, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type LockedDeps = {
  findOwners: LockHistory["findOwners"];
  readRevision(target: LockHistoryTarget): Promise<string | undefined>;
  inspect(id: string, cwd: string): OwnerInspection;
};

type InitialLookup = Awaited<ReturnType<LockedDeps["findOwners"]>>;
type CandidateRevision = { target: LockHistoryTarget; revision: string };
type OwnerScan = {
  probes: Map<string, OwnerProbe>;
  initial?: { lookup: InitialLookup; revisions: ReadonlyMap<string, CandidateRevision> };
};

type LaunchResult = string | false | { retry: string } | { unconfirmed: string };

export interface RunDeps {
  options: DispatchOptions;
  all?: boolean;
  project?: string;
  loadSnapshot: LoadSnapshot;
  log(line: string): void;
  withTickLock?(tick: () => Promise<boolean>): Promise<boolean>;
  readPiSessions(
    snapshot: TicketSnapshot[],
  ): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;
  locked?: LockedDeps;
  launch(
    id: string,
    name: string,
    prompt: string,
    assignment?: LockedAssignment,
  ): LaunchResult | Promise<LaunchResult>;
  sleepMs(ms: number): Promise<void>;
}

export async function run(deps: RunDeps): Promise<void> {
  const { options } = deps;
  const openTemplate = includesStatus(options, "open")
    ? await Bun.file(dispatchPromptPath).text()
    : undefined;
  const locked =
    includesStatus(options, "locked") && deps.locked
      ? { ...deps.locked, template: await Bun.file(lockedPromptPath).text() }
      : undefined;
  const running = new Map<string, string>();
  const started = new Set<string>();
  const seenSessions = new Set<string>();
  const lockedLaunchAttempts = new Map<string, number>();
  const busyProbes = new Map<string, { ownerId: string; revision: string; attempts: number }>();
  const skippedLockReasons = new Map<string, string>();
  function skipLock(id: string, reason: string): void {
    if (skippedLockReasons.get(id) !== reason) deps.log(`skipped ${id}: ${reason}`);
    skippedLockReasons.set(id, reason);
  }
  deps.log(`dispatcher start max=${options.max}`);

  const scope = deps.all ? null : deps.project;
  const cwd = process.cwd();
  function isPendingLocked(ticket: TicketSnapshot): boolean {
    return (
      locked !== undefined &&
      ticket.status === "locked" &&
      !started.has(ticket.id) &&
      (lockedLaunchAttempts.get(ticket.id) ?? 0) < MAX_LOCKED_LAUNCH_ATTEMPTS
    );
  }

  function retryLockedLaunch(id: string, reason: string): void {
    skipLock(id, reason);
    lockedLaunchAttempts.set(id, (lockedLaunchAttempts.get(id) ?? 0) + 1);
  }

  async function scanOwners(): Promise<OwnerScan> {
    const probes = new Map<string, OwnerProbe>();
    if (!locked) return { probes };

    const snapshot = await deps.loadSnapshot();
    const candidates = new Map<string, LockHistoryTarget>();
    for (const ticket of snapshot) {
      if (!isPendingLocked(ticket)) continue;
      const target = lockedTarget(ticket, scope, cwd);
      if (target) candidates.set(ticket.id, target);
    }
    if (candidates.size === 0) return { probes };

    const liveSessions = await deps.readPiSessions(snapshot);
    const newSessions = [...liveSessions].filter(([session]) => !seenSessions.has(session));
    const observedRunning = new Map([...running, ...newSessions]);
    const plan = planTick({
      tickets: snapshot.map((ticket) => ({ ...ticket, actionable: candidates.has(ticket.id) })),
      started,
      running: observedRunning,
      max: options.max,
      hasSession: (session) => liveSessions.has(session),
    });
    if (plan.launches.length === 0) return { probes };

    const liveIds = new Set(liveSessions.values());
    const revisions = new Map<string, CandidateRevision>();
    for (const [key, target] of candidates) {
      if (liveIds.has(key)) continue;
      const revision = await locked.readRevision(target);
      if (revision === undefined) probes.set(key, { skip: "ticket revision unavailable" });
      else revisions.set(key, { target, revision });
    }
    if (revisions.size === 0) return { probes };

    const targets = [...revisions.values()].map(({ target }) => target);
    const lookup = await locked.findOwners(targets).catch(() => undefined);
    if (lookup) return { probes, initial: { lookup, revisions } };
    for (const key of revisions.keys())
      probes.set(key, { skip: "lock history lookup unavailable", retry: true });
    return { probes };
  }

  async function probeOwners({ probes, initial }: OwnerScan): Promise<Map<string, OwnerProbe>> {
    if (!locked || !initial) return probes;
    const { lookup, revisions } = initial;
    const inspected = new Map<string, Omit<PreparedLock, "isOwnerFileCurrent">>();
    const ownerInspections =
      process.platform === "win32" ? undefined : new Map<string, OwnerInspection>();
    for (const [key, { target, revision }] of revisions) {
      const owner = lookup.owners.get(`${target.project}/${target.ticketId}`);
      if (
        !owner ||
        !SESSION_ID_PATTERN.test(owner.ownerId) ||
        !isAbsolute(owner.file) ||
        owner.file.includes("\0")
      ) {
        probes.set(key, { skip: "lock owner unknown" });
        continue;
      }
      const busy = busyProbes.get(key);
      if (busy?.ownerId === owner.ownerId && busy.revision === revision && busy.attempts >= 2) {
        probes.set(key, { skip: "lock owner lookup busy" });
        continue;
      }
      const inspectionKey = ownerInspections && JSON.stringify([owner.ownerId, target.cwd]);
      const previousInspection = inspectionKey && ownerInspections?.get(inspectionKey);
      const inspection = previousInspection || locked.inspect(owner.ownerId, target.cwd);
      if (inspectionKey) ownerInspections?.set(inspectionKey, inspection);
      inspected.set(key, { target, revision, owner, inspection });
    }
    if (inspected.size === 0) return probes;

    const targets = [...revisions.values()].map(({ target }) => target);
    const refreshed = await locked.findOwners(targets).catch(() => undefined);
    for (const [key, probe] of inspected) {
      if (!refreshed) {
        probes.set(key, { skip: "lock history lookup unavailable", retry: true });
        continue;
      }
      const { target, owner } = probe;
      const current = refreshed.owners.get(`${target.project}/${target.ticketId}`);
      if (current?.ownerId !== owner.ownerId || current.file !== owner.file) {
        probes.set(key, { skip: "lock history changed since owner lookup", retry: true });
        continue;
      }
      probes.set(key, {
        ...probe,
        isOwnerFileCurrent: () => refreshed.isOwnerFileCurrent(current),
      });
    }
    return probes;
  }

  async function tick(probes: ReadonlyMap<string, OwnerProbe>): Promise<boolean> {
    const snapshot = await deps.loadSnapshot();
    const liveSessions = await deps.readPiSessions(snapshot);
    for (const [session, id] of liveSessions) {
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      started.add(id);
      running.set(session, id);
    }

    const skipped = deps.all
      ? await validateCwds(
          snapshot,
          (ticket) =>
            !started.has(ticket.id) &&
            ((openTemplate !== undefined && ticket.actionable) ||
              (isPendingLocked(ticket) && lockedTarget(ticket, scope, cwd) !== undefined)),
          deps.log,
        )
      : undefined;

    const readyLocks = new Map<string, PreparedLock>();
    let needsAnotherTick = false;
    function isLockedReady(ticket: TicketSnapshot): boolean {
      const { id } = ticket;
      if (skipped?.has(splitTicketKey(id)[0])) return false;
      if (!lockedTarget(ticket, scope, cwd)) {
        skipLock(id, "unsupported locked assignment");
        return false;
      }
      const probe = probes.get(id);
      if (!probe) {
        needsAnotherTick = true;
        return false;
      }
      if ("skip" in probe) {
        if (probe.retry) {
          retryLockedLaunch(id, probe.skip);
          if (isPendingLocked(ticket)) needsAnotherTick = true;
        } else {
          skipLock(id, probe.skip);
        }
        return false;
      }
      const { owner, revision, inspection } = probe;
      if (inspection === "busy") {
        const previous = busyProbes.get(id);
        const isSameProbe = previous?.ownerId === owner.ownerId && previous.revision === revision;
        const attempts = isSameProbe ? previous.attempts + 1 : 1;
        busyProbes.set(id, { ownerId: owner.ownerId, revision, attempts });
        if (attempts === 1) needsAnotherTick = true;
        skipLock(id, "lock owner lookup busy");
        return false;
      }
      busyProbes.delete(id);
      if (inspection !== "absent") {
        skipLock(
          id,
          inspection === "present" ? "lock owner present" : "lock owner lookup unavailable",
        );
        return false;
      }
      readyLocks.set(id, probe);
      return true;
    }
    const tickets = snapshot.map((ticket) => ({
      ...ticket,
      actionable: isPendingLocked(ticket)
        ? isLockedReady(ticket)
        : openTemplate !== undefined && ticket.actionable,
    }));
    const plan = planTick({
      tickets,
      skipped,
      started,
      running,
      max: options.max,
      hasSession: (session) => liveSessions.has(session),
    });
    for (const entry of plan.done) {
      deps.log(`done ${entry.id} status=${entry.status}`);
      running.delete(entry.session);
    }
    for (const entry of plan.incomplete) {
      deps.log(
        `incomplete ${entry.id} status=${entry.status ?? "none"} session exited without close`,
      );
      running.delete(entry.session);
    }
    for (const id of plan.launches) {
      const name = sessionName(SESSION_NAME_PREFIX, id, deps.all);
      const promptId = deps.all ? splitTicketKey(id)[1] : id;
      const prepared = readyLocks.get(id);
      let prompt: string;
      let assignment: LockedAssignment | undefined;
      if (prepared && locked) {
        const { target, owner, revision } = prepared;
        assignment = { project: target.project, ticketId: target.ticketId, ownerId: owner.ownerId };
        prompt = locked.template.replace("{{ ASSIGNMENT }}", () =>
          JSON.stringify({ ...assignment, ownerSessionFile: owner.file }),
        );
        if ((await locked.readRevision(target)) !== revision) {
          retryLockedLaunch(id, "ticket changed since lock history lookup");
          continue;
        }
        if (!(await prepared.isOwnerFileCurrent())) {
          retryLockedLaunch(id, "lock history changed before launch");
          continue;
        }
      } else {
        prompt = buildPrompt(openTemplate!, promptId);
      }
      const result = await deps.launch(id, name, prompt, assignment);
      if (typeof result === "object" && "retry" in result) {
        retryLockedLaunch(id, result.retry);
        continue;
      }
      started.add(id);
      if (result === false) continue;
      const session = typeof result === "string" ? result : result.unconfirmed;
      running.set(session, id);
      seenSessions.add(session);
      if (typeof result === "string") deps.log(`launched ${id} as ${name}`);
    }
    return plan.finished && !needsAnotherTick;
  }

  let pendingScan: ReturnType<typeof scanOwners> | undefined;
  let inventoryError: string | undefined;
  while (true) {
    try {
      pendingScan ??= scanOwners();
      const scan =
        locked && openTemplate !== undefined
          ? await waitForHistory(pendingScan, tickMs())
          : await pendingScan;
      if (scan) pendingScan = undefined;
      const probes = scan ? await probeOwners(scan) : new Map<string, OwnerProbe>();
      const runTick = () => tick(probes);
      const finished = await (deps.withTickLock ? deps.withTickLock(runTick) : runTick());
      inventoryError = undefined;
      if (finished) {
        await pendingScan;
        break;
      }
      if (!pendingScan) await deps.sleepMs(tickMs());
    } catch (error) {
      const wasBusy = process.platform === "win32" && error instanceof DispatchLockBusy;
      if (!wasBusy && !(error instanceof DispatchInventoryUnavailable)) throw error;
      if (!wasBusy) pendingScan = undefined;
      const { message } = error as Error;
      if (inventoryError !== message) deps.log(message);
      inventoryError = message;
      await deps.sleepMs(tickMs());
    }
  }
  deps.log("dispatcher finished");
}

function startPiSession(input: {
  socket: string;
  project: string;
  id: string;
  name: string;
  cwd: string;
  prompt: string;
}) {
  const { socket, project, id, name, cwd, prompt } = input;
  return tmux(socket, [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    name,
    "-c",
    cwd,
    ...sessionEnvArgs(project, "pi"),
    "-e",
    `${ID_ENV}=${id}`,
    `exec pi -- ${shQuote(prompt)}`,
  ]);
}

type PiMuxLaunch =
  | { state: "launched"; session: string }
  | { state: "present" }
  | { state: "unknown"; detail: string };

async function startPiMuxSession(input: {
  socket: string;
  project: string;
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  ownerId?: string;
}): Promise<PiMuxLaunch> {
  const { socket, project, id, name, cwd, prompt, ownerId } = input;
  const mode = ownerId === undefined ? ["--dispatch-open-ticket"] : ["--dispatch-ticket", ownerId];
  const args = [...mode, socket, project, id, name, cwd, prompt];
  try {
    let response: { exitCode: number; stdout: string; stderr: string };
    if (process.platform === "win32") {
      response = await runWindowsInspection(args);
    } else {
      const child = Bun.spawn(["pi-mux", "inspect", ...args], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      response = { exitCode, stdout, stderr };
    }
    const { exitCode, stdout, stderr } = response;
    if (exitCode !== 0)
      return { state: "unknown", detail: stderr.trim().replace(/\s*\r?\n\s*/g, " ") };
    const value = JSON.parse(stdout);
    if (value?.state === "present") return { state: "present" };
    if (
      value?.state === "launched" &&
      typeof value.session === "string" &&
      /^\$\d+$/.test(value.session)
    )
      return { state: "launched", session: value.session };
  } catch (error) {
    if (!(error instanceof SyntaxError)) return { state: "unknown", detail: String(error) };
  }
  return { state: "unknown", detail: "invalid pi-mux response" };
}

export async function dispatchOne(input: {
  project: string;
  id: string;
  validate: () => Promise<void>;
}): Promise<void> {
  const { project, id } = input;
  const socket = dispatchSocket();
  const template = await Bun.file(dispatchPromptPath).text();
  await withDispatcherLock(socket, async () => {
    await input.validate();
    const name = sessionName(SESSION_NAME_PREFIX, `${project}/${id}`, true);
    const launch = {
      socket,
      project,
      id,
      name,
      cwd: process.cwd(),
      prompt: buildPrompt(template, id),
    };
    if (process.platform === "win32") {
      await requireWindowsManagement(socket);
      const result = await startPiMuxSession(launch);
      if (result.state === "present") throw new Error(`ticket already running: ${project}/${id}`);
      if (result.state === "unknown")
        throw new Error(`tmux new-session failed for ${name}: ${result.detail}`);
      return;
    }

    if ([...readPiSessions(socket, project).values()].includes(id))
      throw new Error(`ticket already running: ${project}/${id}`);
    const result = startPiSession(launch);
    if (!result.ok) throw new Error(`tmux new-session failed for ${name}: ${result.stderr.trim()}`);
  });
}

export async function dispatch(
  options: DispatchOptions,
  loadSnapshot: LoadSnapshot,
  project: string | null,
  socket = dispatchSocket(),
): Promise<void> {
  const cwd = process.cwd();
  const windowsSessions =
    process.platform === "win32" ? windowsPiSessions(socket, project) : undefined;
  function log(line: string): void {
    const stamped = `[${timestamp()}] ${line}`;
    console.log(stamped);
  }
  function reportSessionFailure(name: string, detail: string): void {
    const message = `tmux new-session failed for ${name}: ${detail}`;
    console.error(message);
    log(message);
  }
  async function launch(
    key: string,
    name: string,
    prompt: string,
    assignment?: LockedAssignment,
  ): Promise<LaunchResult> {
    const [owner, id] = project === null ? splitTicketKey(key) : [project, key];
    const targetCwd = project === null ? projectCwd(owner) : cwd;
    const launch = { socket, project: owner, id, name, cwd: targetCwd, prompt };
    if (!assignment && !windowsSessions) {
      const result = startPiSession(launch);
      if (result.ok) return result.stdout.trim();
      reportSessionFailure(name, result.stderr.trim());
      return hasSession(socket, name) ? false : name;
    }

    const result = await startPiMuxSession({ ...launch, ownerId: assignment?.ownerId });
    if (result.state === "launched") return windowsSessions?.launched(name, key) ?? result.session;
    if (!assignment) {
      if (result.state === "present") return false;
      reportSessionFailure(name, result.detail);
      return hasSession(socket, name) ? false : { unconfirmed: name };
    }
    if (result.state === "present") return { retry: "lock owner present" };
    if (hasSession(socket, name)) {
      reportSessionFailure(name, result.detail);
      return false;
    }
    const detail = result.detail ? `: ${result.detail}` : "";
    return { retry: `locked launch unavailable${detail}` };
  }
  try {
    const history = includesStatus(options, "locked") ? new LockHistory() : undefined;
    await run({
      options,
      all: project === null,
      project: project ?? undefined,
      loadSnapshot,
      log,
      withTickLock: (tick) => withDispatcherLock(socket, tick),
      readPiSessions: windowsSessions?.read ?? (() => readPiSessions(socket, project)),
      locked: history
        ? {
            findOwners: (targets) => history.findOwners(targets),
            inspect: inspectOwner,
            readRevision: readTicketRevision,
          }
        : undefined,
      launch,
      sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (error) {
    const message = (error as Error).message;
    log(message);
    throw error;
  }
}
