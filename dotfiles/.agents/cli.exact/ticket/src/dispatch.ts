import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PLACEHOLDER = "__TICKET_ID__";

const OPTION_KEYS = ["--max", "--interval", "--prefix", "--template"];

export interface DispatchOptions {
  template: string;
  fixDir: string;
  log: string;
  max: number;
  prefix: string;
  interval: number;
}

export const DISPATCH_USAGE =
  "ticket dispatch [<work-dir>] [--max N] [--interval SEC] [--prefix NAME] [--template FILE]\n       ticket dispatch start [<work-dir>] [--max N] [--interval SEC] [--prefix NAME] [--template FILE]\n       ticket dispatch stop";

export function sessionName(prefix: string, id: string): string {
  return prefix + id.split(".").join("_");
}

export function buildPrompt(template: string, id: string): string {
  return template.split(PLACEHOLDER).join(id);
}

export interface TicketSnapshot {
  id: string;
  status: string;
  actionable: boolean;
}

export type LoadSnapshot = () => Promise<TicketSnapshot[]>;

export interface PlanInput {
  tickets: TicketSnapshot[];
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
    if (status === "closed" || status === "cancelled") {
      done.push({ id, name, status });
    } else if (!input.hasSession(name)) {
      incomplete.push({ id, name, status });
    }
  }

  const remainingRunning = input.running.size - done.length - incomplete.length;
  const launches = input.tickets
    .filter(
      (ticket) =>
        ticket.actionable && !input.started.has(ticket.id) && !input.running.has(ticket.id),
    )
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
  action?: "start" | "stop";
  options?: DispatchOptions;
  error?: string;
} {
  if (argv[0] === "stop") {
    return argv.length === 1 ? { action: "stop" } : { error: "stop accepts no arguments" };
  }
  if (argv[0] === "start") argv = argv.slice(1);
  const given = new Map<string, string>();
  const positional: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (optionsEnded) positional.push(arg);
    else if (arg === "--") optionsEnded = true;
    else if (OPTION_KEYS.includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--"))
        return { error: `missing value for ${arg}` };
      given.set(arg, value);
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (positional.length > 1) return { error: "accepts at most one work directory" };
  const work = positional[0] ?? process.cwd();
  if (!work) return { error: "work directory must not be empty" };
  const max = given.has("--max") ? Number(given.get("--max")) : 5;
  if (!Number.isInteger(max) || max < 1) return { error: "--max must be an integer >= 1" };
  const interval = given.has("--interval") ? Number(given.get("--interval")) : 30;
  if (!Number.isFinite(interval) || interval <= 0)
    return { error: "--interval must be a number > 0" };
  return {
    action: "start",
    options: {
      template: given.get("--template") ?? join(work, "fix-prompt-template.txt"),
      fixDir: join(work, "fix"),
      log: join(work, "dispatch.log"),
      max,
      prefix: given.get("--prefix") ?? "fix_",
      interval,
    },
  };
}

function timestamp(): string {
  const now = new Date();
  function pad(value: number): string {
    return String(value).padStart(2, "0");
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
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

export function dispatcherName(project: string): string {
  return `ticket_dispatch_${Buffer.from(project).toString("hex")}`;
}

function sessionEnv(socket: string, name: string, key: string): string | undefined {
  const result = tmux(socket, ["show-environment", "-t", `=${name}`, key]);
  if (!result.ok || !result.stdout.startsWith(`${key}=`)) return undefined;
  return result.stdout.slice(key.length + 1, -1);
}

function ownsSession(socket: string, name: string, project: string, role: string): boolean {
  return (
    sessionEnv(socket, name, PROJECT_ENV) === project && sessionEnv(socket, name, ROLE_ENV) === role
  );
}

function sessionEnvArgs(project: string, role: string): string[] {
  const entries = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TICKET_TEST_TMUX_SOCKET: process.env.TICKET_TEST_TMUX_SOCKET,
    [PROJECT_ENV]: project,
    [ROLE_ENV]: role,
  };
  return Object.entries(entries).flatMap(([key, value]) =>
    value === undefined ? [] : ["-e", `${key}=${value}`],
  );
}

export function workerCommand(entry: string, argv: string[], project: string): string[] {
  const executable = entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
  return [...executable, "__ticket_dispatch_worker", project, ...argv];
}

export async function startDispatcher(input: {
  project: string;
  options: DispatchOptions;
  loadSnapshot: LoadSnapshot;
  command: string[];
}): Promise<void> {
  const { project, options } = input;
  const socket = dispatchSocket();
  const name = dispatcherName(project);
  if (ownsSession(socket, name, project, "dispatcher")) {
    console.log(`dispatcher already running: ${name}`);
    return;
  }
  readFileSync(options.template, "utf8");
  await input.loadSnapshot();
  mkdirSync(options.fixDir, { recursive: true });
  appendFileSync(options.log, "");
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
  if (!result.ok) {
    if (ownsSession(socket, name, project, "dispatcher")) {
      console.log(`dispatcher already running: ${name}`);
      return;
    }
    throw new Error(`dispatcher start failed for ${name}: ${result.stderr.trim()}`);
  }
  console.log(`dispatcher started: ${name} log=${options.log}`);
}

export function stopDispatcher(project: string): void {
  const socket = dispatchSocket();
  const name = dispatcherName(project);
  if (!ownsSession(socket, name, project, "dispatcher")) {
    console.log(`dispatcher already stopped: ${name}`);
    return;
  }
  const result = tmux(socket, ["kill-session", "-t", `=${name}`]);
  if (!result.ok && ownsSession(socket, name, project, "dispatcher"))
    throw new Error(`dispatcher stop failed for ${name}: ${result.stderr.trim()}`);
  console.log(`dispatcher stopped: ${name}`);
}

function inheritedSessions(socket: string, project: string): Map<string, string> {
  const result = tmux(socket, ["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) throw new Error(`cannot list dispatch sessions: ${result.stderr.trim()}`);
  const running = new Map<string, string>();
  for (const name of result.stdout.trimEnd().split("\n")) {
    if (!ownsSession(socket, name, project, "pi")) continue;
    const id = sessionEnv(socket, name, ID_ENV);
    if (id) running.set(id, name);
  }
  return running;
}

export function killSession(socket: string, name: string): void {
  tmux(socket, ["kill-session", "-t", `=${name}`]);
}

export function hasSession(socket: string, name: string): boolean {
  return tmux(socket, ["has-session", "-t", `=${name}`]).ok;
}

export interface RunDeps {
  options: DispatchOptions;
  loadSnapshot: LoadSnapshot;
  log(line: string): void;
  hasSession(name: string): boolean;
  initialRunning?: ReadonlyMap<string, string>;
  launch(id: string, name: string, promptFile: string): boolean | void;
  killSession(name: string): void;
  sleepMs(ms: number): Promise<void>;
}

export async function run(deps: RunDeps): Promise<void> {
  const { options } = deps;
  const template = readFileSync(options.template, "utf8");
  mkdirSync(options.fixDir, { recursive: true });
  const running = new Map(deps.initialRunning);
  const started = new Set(running.keys());
  deps.log(`dispatcher start max=${options.max}`);

  while (true) {
    const plan = planTick({
      tickets: await deps.loadSnapshot(),
      started,
      running,
      max: options.max,
      hasSession: (name) => deps.hasSession(name),
    });
    for (const entry of plan.done) {
      deps.log(`done ${entry.id} status=${entry.status}`);
      deps.killSession(entry.name);
      running.delete(entry.id);
    }
    for (const entry of plan.incomplete) {
      deps.log(
        `incomplete ${entry.id} status=${entry.status ?? "none"} session exited without close`,
      );
      running.delete(entry.id);
    }
    for (const id of plan.launches) {
      const name = sessionName(options.prefix, id);
      const promptFile = join(options.fixDir, `prompt-${id}.txt`);
      writeFileSync(promptFile, buildPrompt(template, id));
      started.add(id);
      if (deps.launch(id, name, promptFile) !== false) {
        running.set(id, name);
        deps.log(`launched ${id} as ${name}`);
      }
    }
    if (plan.finished) break;
    await deps.sleepMs(options.interval * 1000);
  }
  deps.log("dispatcher finished");
}

export async function dispatch(
  options: DispatchOptions,
  loadSnapshot: LoadSnapshot,
  project: string,
): Promise<void> {
  const socket = dispatchSocket();
  const cwd = process.cwd();
  function log(line: string): void {
    const stamped = `[${timestamp()}] ${line}`;
    console.log(stamped);
    appendFileSync(options.log, `${stamped}\n`);
  }
  function launch(id: string, name: string, promptFile: string): boolean {
    const command = `prompt="$(cat ${shQuote(promptFile)} && printf .)" && exec pi "\${prompt%.}"`;
    const result = tmux(socket, [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      ...sessionEnvArgs(project, "pi"),
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
      loadSnapshot,
      log,
      initialRunning: inheritedSessions(socket, project),
      hasSession: (name) => hasSession(socket, name) && ownsSession(socket, name, project, "pi"),
      launch,
      killSession: (name) => {
        if (ownsSession(socket, name, project, "pi")) killSession(socket, name);
      },
      sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (error) {
    const message = (error as Error).message;
    try {
      log(message);
    } catch (logError) {
      console.error(`dispatcher log failed: ${(logError as Error).message}`);
    }
    throw error;
  }
}
