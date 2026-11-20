import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  "ticket dispatch list\n       ticket dispatch [-p|--project <project>] [-a|--all] [--max N]\n       ticket dispatch start [-p|--project <project>] [-a|--all] [--max N]\n       ticket dispatch stop [-p|--project <project>] [-a|--all]";

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
  hasSession(name: string): boolean;
}

export interface DoneEntry {
  id: string;
  name: string;
  status: string;
}

export interface IncompleteEntry {
  id: string;
  name: string;
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

  for (const [id, name] of input.running) {
    const status = byId.get(id)?.status ?? null;
    if (
      status === "closed" ||
      status === "cancelled" ||
      status === "blocked" ||
      status === "draft"
    ) {
      done.push({ id, name, status });
    } else if (!input.hasSession(name)) {
      incomplete.push({ id, name, status });
    }
  }

  const remainingRunning = input.running.size - done.length - incomplete.length;
  const candidates = input.tickets
    .filter(
      (ticket) =>
        ticket.actionable && !input.started.has(ticket.id) && !input.running.has(ticket.id),
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
  action?: "start" | "stop" | "list";
  project?: string;
  all?: boolean;
  options?: DispatchOptions;
  error?: string;
} {
  const action =
    argv[0] === "stop" ? "stop" : argv[0] === "list" ? "list" : "start";
  if (argv[0] === "start" || argv[0] === "stop" || argv[0] === "list")
    argv = argv.slice(1);
  const given = new Map<string, string>();
  let project: string | undefined;
  let all = false;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (action === "list") return { error: `unknown option: ${arg}` };
    const isProject = arg === "-p" || arg === "--project";
    if (optionsEnded) return { error: "positional arguments are not supported" };
    if (arg === "--") optionsEnded = true;
    else if (arg === "-a" || arg === "--all") all = true;
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
      if (isProject) project = value;
      else given.set(arg, value);
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else return { error: "positional arguments are not supported" };
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

function sessionEnv(socket: string, name: string, key: string): string | undefined {
  const result = tmux(socket, ["show-environment", "-t", `=${name}`, key]);
  if (!result.ok || !result.stdout.startsWith(`${key}=`)) return undefined;
  return result.stdout.slice(key.length + 1, -1);
}

function ownsSession(socket: string, name: string, project: string | null, role: string): boolean {
  const owner = sessionEnv(socket, name, PROJECT_ENV);
  const matchesProject =
    project === null && role === "pi" ? Boolean(owner) : owner === (project ?? "");
  return matchesProject && sessionEnv(socket, name, ROLE_ENV) === role;
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
  const database = new Database(join(tmpdir(), `ticket-dispatch-${key}.sqlite`));
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

function sessionNames(socket: string, allowMissing = false): string[] {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) {
    if (allowMissing) return [];
    throw new Error(`cannot list dispatch sessions: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd().split("\n");
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
    if (ownsSession(socket, name, project, "dispatcher")) {
      console.log(`dispatcher already running: ${name}`);
      return;
    }
    for (const other of sessionNames(socket, true)) {
      if (sessionEnv(socket, other, ROLE_ENV) !== "dispatcher") continue;
      const owner = sessionEnv(socket, other, PROJECT_ENV);
      if (owner !== undefined && (project === null || owner === ""))
        throw new Error(`overlapping dispatcher already running: ${other}`);
    }
    await Bun.file(dispatchPromptPath).text();
    const tickets = await input.loadSnapshot();
    if (project === null)
      await validateCwds(
        tickets,
        new Set(inheritedSessions(socket, project, true).keys()),
        console.log,
      );
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
    console.log(`dispatcher started: ${name}`);
  });
}

export async function stopDispatcher(project: string | null): Promise<void> {
  const socket = dispatchSocket();
  await withDispatcherLock(socket, async () => {
    const name = dispatcherName(project);
    if (!ownsSession(socket, name, project, "dispatcher")) {
      console.log(`dispatcher already stopped: ${name}`);
      return;
    }
    const result = tmux(socket, ["kill-session", "-t", `=${name}`]);
    if (!result.ok && ownsSession(socket, name, project, "dispatcher"))
      throw new Error(`dispatcher stop failed for ${name}: ${result.stderr.trim()}`);
    console.log(`dispatcher stopped: ${name}`);
  });
}

function inheritedSessions(
  socket: string,
  project: string | null,
  allowMissing = false,
): Map<string, string> {
  const running = new Map<string, string>();
  for (const name of sessionNames(socket, allowMissing)) {
    if (!ownsSession(socket, name, project, "pi")) continue;
    const id = sessionEnv(socket, name, ID_ENV);
    const owner = sessionEnv(socket, name, PROJECT_ENV);
    if (id) running.set(project === null ? `${owner}/${id}` : id, name);
  }
  return running;
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
    if (sessionEnv(socket, name, ROLE_ENV) !== "dispatcher") continue;
    const owner = sessionEnv(socket, name, PROJECT_ENV);
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
  hasSession(name: string): boolean;
  initialRunning?: ReadonlyMap<string, string>;
  launch(id: string, name: string, prompt: string): boolean | void;
  sleepMs(ms: number): Promise<void>;
}

export async function run(deps: RunDeps): Promise<void> {
  const { options } = deps;
  const template = await Bun.file(dispatchPromptPath).text();
  const running = new Map(deps.initialRunning);
  const started = new Set(running.keys());
  deps.log(`dispatcher start max=${options.max}`);

  while (true) {
    const tickets = await deps.loadSnapshot();
    const skipped = deps.all ? await validateCwds(tickets, started, deps.log) : undefined;
    const plan = planTick({
      tickets,
      skipped,
      started,
      running,
      max: options.max,
      hasSession: (name) => deps.hasSession(name),
    });
    for (const entry of plan.done) {
      deps.log(`done ${entry.id} status=${entry.status}`);
      running.delete(entry.id);
    }
    for (const entry of plan.incomplete) {
      deps.log(
        `incomplete ${entry.id} status=${entry.status ?? "none"} session exited without close`,
      );
      running.delete(entry.id);
    }
    for (const id of plan.launches) {
      const name = sessionName(SESSION_NAME_PREFIX, id, deps.all);
      const promptId = deps.all ? splitTicketKey(id)[1] : id;
      started.add(id);
      if (deps.launch(id, name, buildPrompt(template, promptId)) !== false) {
        running.set(id, name);
        deps.log(`launched ${id} as ${name}`);
      }
    }
    if (plan.finished) break;
    await deps.sleepMs(tickMs());
  }
  deps.log("dispatcher finished");
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
  function launch(key: string, name: string, prompt: string): boolean {
    const [owner, id] = project === null ? splitTicketKey(key) : [project, key];
    const targetCwd = project === null ? join(homedir(), "projects", owner) : cwd;
    const command = `exec pi ${shQuote(prompt)}`;
    const result = tmux(socket, [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      targetCwd,
      ...sessionEnvArgs(owner, "pi"),
      "-e",
      `${ID_ENV}=${id}`,
      command,
    ]);
    if (result.ok) return true;
    const message = `tmux new-session failed for ${name}: ${result.stderr.trim()}`;
    console.error(message);
    log(message);
    return !hasSession(socket, name);
  }
  try {
    await run({
      options,
      all: project === null,
      loadSnapshot,
      log,
      initialRunning: inheritedSessions(socket, project),
      hasSession: (name) => hasSession(socket, name) && ownsSession(socket, name, project, "pi"),
      launch,
      sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (error) {
    const message = (error as Error).message;
    log(message);
    throw error;
  }
}
