import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TmuxConfig } from "./configuration";
import { platform } from "./platform";
import { isRecord, STARTUP_TIMEOUT_MS, UUID } from "./session-model";
import {
  assertWindowsLaunchDirectory,
  hasPlainLocalWindowsDirectory,
  isPlainWindowsLaunchFile,
} from "./windows/windows-launch-directory";

export const INITIAL_REQUEST_DIRECTORY = "pi-mux-launch-argv";
export const INITIAL_REQUEST_TTL_MS = 2 * STARTUP_TIMEOUT_MS;
const ARGUMENT_FILE_SUFFIXES = [".json", ".part"] as const;

type LaunchIdentity = {
  socket: string;
  session: string;
  generation: string;
  id: string;
  launchToken: string;
  serverPid?: number;
};

type InitialRequestLaunch = LaunchIdentity & { cwd: string; command: string[] };
type ExpectedLaunch = LaunchIdentity & { cwd?: string };

function initialRequestDirectory(config: Pick<TmuxConfig, "directory">): string {
  const parent = platform.windows ? process.env.LOCALAPPDATA : config.directory;
  if (parent === undefined || !isAbsolute(parent))
    throw new Error("No private location for initial-request files");
  return join(parent, INITIAL_REQUEST_DIRECTORY);
}

function assertPrivateUnixDirectory(path: string) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o777) !== 0o700)
    throw new Error("Unsafe private initial-request directory");
}

function ensurePrivateDirectory(directory: string, create: boolean) {
  if (platform.windows) {
    assertWindowsLaunchDirectory(directory, create);
    return;
  }
  const muxRuntime = dirname(directory);
  const runtime = dirname(muxRuntime);
  if (realpathSync(runtime) !== resolve(runtime))
    throw new Error("Cannot use a linked initial-request runtime directory");
  assertPrivateUnixDirectory(runtime);
  assertPrivateUnixDirectory(muxRuntime);
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertPrivateUnixDirectory(directory);
}

function plainOwnedFile(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.nlink !== 1) return;
  if (platform.windows) return isPlainWindowsLaunchFile(path) ? entry : undefined;
  if (entry.uid === process.getuid!() && (entry.mode & 0o777) === 0o600) return entry;
}

function launchFileName(token: string, suffix: (typeof ARGUMENT_FILE_SUFFIXES)[number]) {
  if (token.length !== 36 || !UUID.test(token)) throw new Error("Invalid initial-request token");
  return token + suffix;
}

function unlinkIfPresent(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function matchesInitialRequest(
  launch: unknown,
  expected: ExpectedLaunch,
): launch is InitialRequestLaunch {
  if (!isRecord(launch)) return false;
  const { cwd, command, ...identity } = launch;
  const { cwd: expectedCwd, ...expectedIdentity } = expected;
  const expectedEntries = Object.entries(expectedIdentity);
  return (
    Object.keys(identity).length === expectedEntries.length &&
    expectedEntries.every(
      ([name, expectedValue]) => Object.hasOwn(identity, name) && identity[name] === expectedValue,
    ) &&
    typeof cwd === "string" &&
    isAbsolute(cwd) &&
    !cwd.includes("\0") &&
    (expectedCwd === undefined || cwd === expectedCwd) &&
    Array.isArray(command) &&
    typeof command[0] === "string" &&
    isAbsolute(command[0]) &&
    command.every((argument: unknown) => typeof argument === "string" && !argument.includes("\0"))
  );
}

export class InitialRequestFiles {
  private constructor(private readonly directory: string) {}

  static open(config: Pick<TmuxConfig, "directory">, create = false): InitialRequestFiles {
    const directory = initialRequestDirectory(config);
    ensurePrivateDirectory(directory, create);
    return new InitialRequestFiles(directory);
  }

  static sweep(config: Pick<TmuxConfig, "directory">, now = Date.now()): void {
    try {
      const directory = initialRequestDirectory(config);
      if (platform.windows) {
        if (!hasPlainLocalWindowsDirectory(directory)) return;
      } else if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
        return;
      }
      ensurePrivateDirectory(directory, false);
      const candidates = readdirSync(directory).filter((name) => {
        const token = name.slice(0, 36);
        return UUID.test(token) && ARGUMENT_FILE_SUFFIXES.some((suffix) => name === token + suffix);
      });
      for (const name of candidates) {
        const file = join(directory, name);
        try {
          const entry = plainOwnedFile(file);
          if (entry && now - entry.mtimeMs >= INITIAL_REQUEST_TTL_MS) unlinkIfPresent(file);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  publish(token: string, launch: InitialRequestLaunch): void {
    const pending = join(this.directory, launchFileName(token, ".part"));
    const file = join(this.directory, launchFileName(token, ".json"));
    const descriptor = openSync(pending, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(launch));
      } finally {
        closeSync(descriptor);
      }
      renameSync(pending, file);
    } catch {
      unlinkIfPresent(pending);
      throw new Error("Cannot store the initial-request arguments");
    }
  }

  take(token: string, expected: ExpectedLaunch, now = Date.now()): InitialRequestLaunch {
    try {
      const file = join(this.directory, launchFileName(token, ".json"));
      const entry = plainOwnedFile(file);
      if (!entry || now - entry.mtimeMs >= INITIAL_REQUEST_TTL_MS) throw new Error();
      const flags = platform.windows
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
      const descriptor = openSync(file, flags);
      let launch: unknown;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino)
          throw new Error();
        launch = JSON.parse(readFileSync(descriptor, "utf8"));
      } finally {
        closeSync(descriptor);
      }
      if (!matchesInitialRequest(launch, expected)) throw new Error();
      unlinkSync(file);
      return launch;
    } catch {
      throw new Error("Cannot claim the initial-request arguments for this launch");
    }
  }

  cancel(token: string): void {
    const file = join(this.directory, launchFileName(token, ".json"));
    if (plainOwnedFile(file)) unlinkIfPresent(file);
  }
}
