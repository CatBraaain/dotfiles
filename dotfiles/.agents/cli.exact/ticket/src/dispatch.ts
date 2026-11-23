import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database, SQLiteError } from "bun:sqlite";
import dispatchPromptPath from "../dispatch-prompt.md" with { type: "file" };

const OPTION_KEYS = ["--max"];

const SESSION_NAME_PREFIX = "handle_";

const DEFAULT_TICK_MS = 3_000;

export interface DispatchOptions {
  max: number;
}

export const DISPATCH_USAGE =
  "ticket dispatch list\n       ticket dispatch [-p|--project <project>] [-a|--all] [--max N]\n       ticket dispatch start [-p|--project <project>] [-a|--all] [--max N]\n       ticket dispatch stop [-p|--project <project>] [-a|--all]\n       ticket dispatch one --project <project> <id>";

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

async function validateCwds(
  tickets: TicketSnapshot[],
  started: ReadonlySet<string>,
  log: (line: string) => void,
): Promise<Set<string>> {
  const skipped = new Set<string>();
  const projects = new Set(
    tickets
      .filter((ticket) => ticket.actionable && !started.has(ticket.id))
      .map((ticket) => splitTicketKey(ticket.id)[0]),
  );
  for (const project of projects) {
    const cwd = join(homedir(), "projects", project);
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
  return { action: "start", project, all, options: { max } };
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
  const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

const PROJECT_ENV = "TICKET_DISPATCH_PROJECT";
const ROLE_ENV = "TICKET_DISPATCH_ROLE";
const ID_ENV = "TICKET_DISPATCH_ID";

export function dispatchSocket(): string {
  return process.env.TICKET_TEST_TMUX_SOCKET ?? "/run/user/1000/pi-tmux/server.sock";
}

export function dispatcherName(project: string | null): string {
  return project === null
    ? "ticket_dispatch_all"
    : `ticket_dispatch_${Buffer.from(project).toString("hex")}`;
}

function sessionEnv(socket: string, target: string, key: string): string | undefined {
  const result = tmux(socket, ["show-environment", "-t", target, key]);
  if (!result.ok || !result.stdout.startsWith(`${key}=`)) return undefined;
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
  const executable = entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
  return [...executable, "__ticket_dispatch_worker", project ?? "", ...argv];
}

const DISPATCH_LOCK_TIMEOUT_MS = 4_000;
const DISPATCH_LOCK_RETRY_MS = 10;

async function withDispatcherLock<T>(socket: string, operation: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(socket).digest("hex");
  const database = new Database(`/tmp/ticket-dispatch-${key}.sqlite`);
  const deadline = Date.now() + DISPATCH_LOCK_TIMEOUT_MS;
  try {
    while (true) {
      try {
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline)
          throw new Error(`timed out waiting for dispatcher lock: ${socket}`);
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

export async function startDispatcher(input: {
  project: string | null;
  loadSnapshot: LoadSnapshot;
  command: string[];
}): Promise<void> {
  const { project } = input;
  const socket = dispatchSocket();
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
    await Bun.file(dispatchPromptPath).text();
    const tickets = await input.loadSnapshot();
    if (project === null)
      await validateCwds(tickets, new Set(readPiSessions(socket, project).values()), console.log);
    const result = tmux(socket, [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      process.cwd(),
      ...sessionEnvArgs(project, "dispatcher"),
      `exec ${input.command.map(shQuote).join(" ")}`,
    ]);
    if (!result.ok) throw new Error(`dispatcher start failed for ${name}: ${result.stderr.trim()}`);
    console.log(`dispatcher ${restarted ? "restarted" : "started"}: ${name}`);
  });
}

export async function stopDispatcher(project: string | null): Promise<void> {
  const socket = dispatchSocket();
  await withDispatcherLock(socket, async () => {
    const name = dispatcherName(project);
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

function readPiSessions(socket: string, project: string | null): Map<string, string> {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_id}"]);
  if (!result.ok) {
    if (
      /^no server running on |^error connecting to .*\(No such file or directory\)/.test(
        result.stderr,
      )
    )
      return new Map();
    throw new Error(`cannot list dispatch sessions: ${result.stderr.trim()}`);
  }

  const sessions = new Map<string, string>();
  for (const session of result.stdout.trimEnd().split("\n")) {
    if (sessionEnv(socket, session, ROLE_ENV) !== "pi") continue;
    const owner = sessionEnv(socket, session, PROJECT_ENV);
    if (!owner || (project !== null && owner !== project)) continue;
    const id = sessionEnv(socket, session, ID_ENV);
    if (id) sessions.set(session, project === null ? `${owner}/${id}` : id);
  }
  return sessions;
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
  const result = tmux(socket, [
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_created}",
  ]);
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

export interface RunDeps {
  options: DispatchOptions;
  all?: boolean;
  loadSnapshot: LoadSnapshot;
  log(line: string): void;
  withTickLock?(tick: () => Promise<boolean>): Promise<boolean>;
  readPiSessions(): ReadonlyMap<string, string>;
  launch(id: string, name: string, prompt: string): string | false;
  sleepMs(ms: number): Promise<void>;
}

export async function run(deps: RunDeps): Promise<void> {
  const { options } = deps;
  const template = await Bun.file(dispatchPromptPath).text();
  const running = new Map<string, string>();
  const started = new Set<string>();
  const seenSessions = new Set<string>();
  deps.log(`dispatcher start max=${options.max}`);

  async function tick(): Promise<boolean> {
    const tickets = await deps.loadSnapshot();
    const liveSessions = deps.readPiSessions();
    for (const [session, id] of liveSessions) {
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      started.add(id);
      running.set(session, id);
    }

    const skipped = deps.all ? await validateCwds(tickets, started, deps.log) : undefined;
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
      started.add(id);
      const session = deps.launch(id, name, buildPrompt(template, promptId));
      if (session === false) continue;
      running.set(session, id);
      seenSessions.add(session);
      deps.log(`launched ${id} as ${name}`);
    }
    return plan.finished;
  }

  while (true) {
    const finished = await (deps.withTickLock ? deps.withTickLock(tick) : tick());
    if (finished) break;
    await deps.sleepMs(tickMs());
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
    `exec pi ${shQuote(prompt)}`,
  ]);
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
    if ([...readPiSessions(socket, project).values()].includes(id))
      throw new Error(`ticket already running: ${project}/${id}`);

    const name = sessionName(SESSION_NAME_PREFIX, `${project}/${id}`, true);
    const result = startPiSession({
      socket,
      project,
      id,
      name,
      cwd: process.cwd(),
      prompt: buildPrompt(template, id),
    });
    if (!result.ok) throw new Error(`tmux new-session failed for ${name}: ${result.stderr.trim()}`);
  });
}

export async function dispatch(
  options: DispatchOptions,
  loadSnapshot: LoadSnapshot,
  project: string | null,
): Promise<void> {
  const socket = dispatchSocket();
  const cwd = process.cwd();
  function log(line: string): void {
    const stamped = `[${timestamp()}] ${line}`;
    console.log(stamped);
  }
  function launch(key: string, name: string, prompt: string): string | false {
    const [owner, id] = project === null ? splitTicketKey(key) : [project, key];
    const targetCwd = project === null ? join(homedir(), "projects", owner) : cwd;
    const result = startPiSession({ socket, project: owner, id, name, cwd: targetCwd, prompt });
    if (result.ok) return result.stdout.trim();
    const message = `tmux new-session failed for ${name}: ${result.stderr.trim()}`;
    console.error(message);
    log(message);
    return hasSession(socket, name) ? false : name;
  }
  try {
    await run({
      options,
      all: project === null,
      loadSnapshot,
      log,
      withTickLock: (tick) => withDispatcherLock(socket, tick),
      readPiSessions: () => readPiSessions(socket, project),
      launch,
      sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (error) {
    const message = (error as Error).message;
    log(message);
    throw error;
  }
}
