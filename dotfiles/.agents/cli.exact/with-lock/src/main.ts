import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { constants as osConstants } from "node:os";

const USAGE = `usage: with-lock [-n] [-w <seconds>] [-E <code>] <name> <command> [args...]`;

const POLL_INTERVAL_MS = 200;
const DEFAULT_CONFLICT_EXIT_CODE = 1;
const MAX_CONFLICT_EXIT_CODE = 255;
const EXIT_CODE_ERROR = 2;
const SIGNAL_EXIT_CODE_BASE = 128;
const HASH_LENGTH = 16;
const FALLBACK_UID = 1000;

interface Options {
  lockName: string;
  waitSeconds: number | undefined;
  conflictExitCode: number;
  command: readonly [string, ...string[]];
}

async function run(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error);
    console.error(USAGE);
    return EXIT_CODE_ERROR;
  }

  let server: Server | undefined;
  const socketName = lockSocketName(options.lockName);
  if (socketName !== undefined) {
    try {
      const lock = await acquireLock(socketName, options.waitSeconds);
      if (lock === "busy") return options.conflictExitCode;
      server = lock;
    } catch (error) {
      return fail(error);
    }
  }

  try {
    return await runCommand(options.command);
  } catch (error) {
    return fail(error);
  } finally {
    server?.close();
  }
}

function fail(error: unknown): number {
  console.error(`with-lock: ${errorMessage(error)}`);
  return EXIT_CODE_ERROR;
}

function parseArgs(argv: readonly string[]): Options {
  const rest = [...argv];
  let waitSeconds: number | undefined;
  let conflictExitCode = DEFAULT_CONFLICT_EXIT_CODE;
  let arg = rest[0];
  while (isOption(arg)) {
    rest.shift();
    if (arg === "--") break;
    if (arg === "-n") waitSeconds = 0;
    else if (arg === "-w") waitSeconds = parseWaitSeconds(requireValue(rest.shift(), arg));
    else if (arg === "-E") conflictExitCode = parseExitCode(requireValue(rest.shift(), arg));
    else throw new Error(`unknown option: ${arg}`);
    arg = rest[0];
  }

  const lockName = rest.shift();
  if (lockName === undefined) throw new Error("missing <name>");
  if (rest[0] === "--") rest.shift();
  const [commandName, ...commandArgs] = rest;
  if (commandName === undefined) throw new Error("missing <command>");
  return { lockName, waitSeconds, conflictExitCode, command: [commandName, ...commandArgs] };
}

function isOption(arg: string | undefined): arg is string {
  return arg !== undefined && arg.startsWith("-");
}

function requireValue(value: string | undefined, option: string): string {
  if (value === undefined) throw new Error(`option ${option} requires a value`);
  return value;
}

function parseWaitSeconds(value: string): number {
  const seconds = Number(value);
  if (value.trim() === "" || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`invalid -w value: ${value}`);
  }
  return seconds;
}

function parseExitCode(value: string): number {
  const code = Number(value);
  if (!/^\d+$/.test(value) || code > MAX_CONFLICT_EXIT_CODE) {
    throw new Error(`invalid -E value: ${value}`);
  }
  return code;
}

function lockSocketName(lockName: string): string | undefined {
  const hash = createHash("sha256").update(lockName).digest("hex").slice(0, HASH_LENGTH);
  if (process.platform === "linux") {
    return `\0with-lock-${hash}-${process.getuid?.() ?? FALLBACK_UID}`;
  }
  if (process.platform === "win32") return `\\\\.\\pipe\\with-lock-${hash}`;
  return undefined;
}

async function acquireLock(
  socketName: string,
  waitSeconds: number | undefined,
): Promise<Server | "busy"> {
  const deadlineMs = waitSeconds === undefined ? Infinity : performance.now() + waitSeconds * 1000;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    const error = await listen(server, socketName);
    if (error === undefined) return server;
    if (error.code !== "EADDRINUSE") throw error;
    const remainingMs = deadlineMs - performance.now();
    if (remainingMs <= 0) return "busy";
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    if (performance.now() >= deadlineMs) return "busy";
  }
}

function listen(server: Server, socketName: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    server.once("error", resolve);
    server.listen(socketName, () => resolve(undefined));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: readonly [string, ...string[]]): Promise<number> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command;
    const child = spawn(file, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(childExitCode(code, signal)));
    process.on("SIGTERM", forwardSignal);
    process.on("SIGINT", forwardSignal);

    function forwardSignal(signal: NodeJS.Signals) {
      child.kill(signal);
    }
  });
}

function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) return SIGNAL_EXIT_CODE_BASE + osConstants.signals[signal];
  return code ?? EXIT_CODE_ERROR;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
