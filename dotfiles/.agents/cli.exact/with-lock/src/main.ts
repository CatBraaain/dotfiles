import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { constants as osConstants, homedir } from "node:os";
import { dirname, join } from "node:path";

const USAGE = `usage: with-lock [-n] [-w <seconds>] [-E <code>] <name> <command> [args...]`;

const POLL_INTERVAL_MS = 200;
const DEFAULT_CONFLICT_EXIT_CODE = 1;
const MAX_CONFLICT_EXIT_CODE = 255;
const EXIT_CODE_ERROR = 2;
const SIGNAL_EXIT_CODE_BASE = 128;
const HASH_LENGTH = 16;
const LOCK_EX = 2;
const LOCK_NB = 4;
const ERRNO_BYTES = 4;
const LITTLE_ENDIAN = true;

interface FlockPlatform {
  library: string;
  errnoLocation: string;
}

const FLOCK_PLATFORMS: Record<"linux" | "darwin", FlockPlatform> = {
  linux: { library: "libc.so.6", errnoLocation: "__errno_location" },
  darwin: { library: "/usr/lib/libSystem.B.dylib", errnoLocation: "__error" },
};

interface Options {
  lockName: string;
  waitSeconds: number | undefined;
  conflictExitCode: number;
  command: readonly [string, ...string[]];
}

interface FlockTarget {
  kind: "flock";
  path: string;
  platform: FlockPlatform;
}

interface PipeTarget {
  kind: "pipe";
  name: string;
}

type LockTarget = FlockTarget | PipeTarget;

interface Lock {
  release: () => void;
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

  let lock: Lock | undefined;
  const target = lockTarget(options.lockName);
  if (target !== undefined) {
    try {
      const acquired = await acquireLock(target, options.waitSeconds);
      if (acquired === "busy") return options.conflictExitCode;
      lock = acquired;
    } catch (error) {
      return fail(error);
    }
  }

  try {
    return await runCommand(options.command);
  } catch (error) {
    return fail(error);
  } finally {
    lock?.release();
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

function lockTarget(lockName: string): LockTarget | undefined {
  const hash = createHash("sha256").update(lockName).digest("hex").slice(0, HASH_LENGTH);
  const flockPlatform =
    process.platform === "linux" || process.platform === "darwin"
      ? FLOCK_PLATFORMS[process.platform]
      : undefined;
  if (flockPlatform !== undefined)
    return { kind: "flock", path: join(lockFileDir(), `${hash}.lock`), platform: flockPlatform };
  if (process.platform === "win32") return { kind: "pipe", name: `\\\\.\\pipe\\with-lock-${hash}` };
  return undefined;
}

function lockFileDir(): string {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "with-lock");
}

async function acquireLock(
  target: LockTarget,
  waitSeconds: number | undefined,
): Promise<Lock | "busy"> {
  const deadlineMs = waitSeconds === undefined ? Infinity : performance.now() + waitSeconds * 1000;
  for (;;) {
    const attempt = target.kind === "flock" ? tryFlock(target) : await tryListenPipe(target.name);
    if (attempt !== "busy") return attempt;
    const remainingMs = deadlineMs - performance.now();
    if (remainingMs <= 0) return "busy";
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    if (performance.now() >= deadlineMs) return "busy";
  }
}

function tryFlock(target: FlockTarget): Lock | "busy" {
  mkdirSync(dirname(target.path), { recursive: true });
  const fd = openSync(target.path, "a");
  if (flockNonBlocking(fd, target.platform) === "busy") {
    closeSync(fd);
    return "busy";
  }
  return { release: () => closeSync(fd) };
}

type ErrnoPointer = Parameters<typeof toArrayBuffer>[0];

interface FlockLibrary {
  flock: (fd: number, operation: number) => number;
  errnoLocation: () => ErrnoPointer;
  strerror: (errno: number) => string;
}

let flockLibrary: FlockLibrary | undefined;

function flockNonBlocking(fd: number, flockPlatform: FlockPlatform): "acquired" | "busy" {
  const library = loadFlockLibrary(flockPlatform);
  const errnoPointer = library.errnoLocation();
  if (library.flock(fd, LOCK_EX | LOCK_NB) === 0) return "acquired";

  const errno = new DataView(toArrayBuffer(errnoPointer, 0, ERRNO_BYTES)).getInt32(
    0,
    LITTLE_ENDIAN,
  );
  if (errno === osConstants.errno.EWOULDBLOCK) return "busy";
  throw new Error(`flock failed: ${library.strerror(errno)}`);
}

function loadFlockLibrary(flockPlatform: FlockPlatform): FlockLibrary {
  if (flockLibrary !== undefined) return flockLibrary;
  const symbols = dlopen(flockPlatform.library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    strerror: { args: [FFIType.i32], returns: FFIType.cstring },
    [flockPlatform.errnoLocation]: { args: [], returns: FFIType.ptr },
  }).symbols;
  flockLibrary = {
    flock: symbols.flock as FlockLibrary["flock"],
    errnoLocation: symbols[flockPlatform.errnoLocation] as () => ErrnoPointer,
    strerror: symbols.strerror as FlockLibrary["strerror"],
  };
  return flockLibrary;
}

async function tryListenPipe(name: string): Promise<Lock | "busy"> {
  const server = createServer((socket) => socket.destroy());
  const error = await listen(server, name);
  if (error === undefined) return { release: () => server.close() };
  if (error.code !== "EADDRINUSE") throw error;
  return "busy";
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
