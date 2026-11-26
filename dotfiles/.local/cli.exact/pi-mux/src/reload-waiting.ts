import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TmuxConfig } from "./configuration";
import { canonicalSocketPath } from "./locks";
import { platform } from "./platform";
import { errorMessage, isRecord, SESSION_ID_PATTERN } from "./session-model";
import { serverLifetime, type ServerLifetime, windowsManagement } from "./mux";
import {
  isWindowsManagementBasis,
  launchBasisStillLive,
  type WindowsManagementBasis,
} from "./windows/windows-launch-rights";
import type { WindowsManagement } from "./windows/windows-management";
import { inspectWindowsProcess, isWindowsProcessIdentity } from "./windows/windows-process";

type ReloadBasis = ServerLifetime | WindowsManagementBasis;
export type ReloadWaitingTarget = { id: string; session: string; name?: string };

type ReloadWaitingRecord = {
  basis: ReloadBasis;
  pid: number;
  started: string;
  targets: ReloadWaitingTarget[];
};

const RECORD_NAME = /^reload-wait-[0-9a-f-]{36}\.json$/;
const PROCESS_START_TIME = /^\d+$/;
const PROC_START_TIME_INDEX = 19;

export class ReloadWaiting {
  private readonly name = `reload-wait-${randomUUID()}.json`;
  private directory?: string;
  private started?: string;
  private targets: ReloadWaitingTarget[] = [];
  private publishedTargets = "[]";

  constructor(
    private readonly config: TmuxConfig,
    private readonly basis: ReloadBasis,
  ) {}

  replace(waiting: readonly ReloadWaitingTarget[]): void {
    const unique = new Map(
      waiting.map(({ id, session, name }) => [
        waitingKey({ id, session, name }),
        { id, session, name: platform.windows ? name : undefined },
      ]),
    );
    const targets = [...unique.keys()].sort().map((key) => unique.get(key)!);
    this.targets = targets;
    const serialized = JSON.stringify(targets);
    if (serialized === this.publishedTargets) return;
    try {
      const directory = (this.directory ??= waitingDirectory(this.config));
      const path = join(directory, this.name);
      if (!targets.length) {
        if (hasWaitingDirectory(directory)) unlinkIfPresent(path);
      } else {
        const started = (this.started ??= processStartTime(process.pid));
        if (!started) return;
        ensureWaitingDirectory(directory);
        this.writeRecord(path, { basis: this.basis, pid: process.pid, started, targets });
      }
      this.publishedTargets = serialized;
    } catch {
      return;
    }
  }

  settle(id: string): void {
    this.replace(this.targets.filter((target) => target.id !== id));
  }

  private writeRecord(path: string, record: ReloadWaitingRecord): void {
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      if (removeOptionalRecord(path)) this.publishedTargets = "[]";
      throw error;
    } finally {
      removeOptionalRecord(temporary);
    }
  }
}

export async function readReloadWaiting(config: TmuxConfig): Promise<ReadonlySet<string>> {
  const waiting = new Set<string>();
  const management = platform.windows ? windowsManagement(config) : undefined;
  const directory = waitingDirectory(config, management);
  const livePaths = waitingRecordPaths(directory).filter(
    (path) => readLiveRecord(path) !== undefined,
  );
  if (!livePaths.length) return waiting;
  const basis = management
    ? await management.currentBasis()
    : await serverLifetime({ ...config, noStart: true });
  if (!basis) return waiting;
  for (const path of livePaths) {
    const record = readLiveRecord(path);
    if (record && matchesBasis(record.basis, basis))
      for (const target of record.targets) waiting.add(waitingKey(target));
  }
  return waiting;
}

export function waitingKey({ id, session, name }: ReloadWaitingTarget): string {
  return JSON.stringify([id, session, platform.windows ? name : undefined]);
}

function waitingDirectory(config: TmuxConfig, management?: WindowsManagement): string {
  return platform.windows
    ? join((management ?? windowsManagement(config)).scope.storageDirectory, "reload-wait")
    : `${canonicalSocketPath(config.socket)}.reload-wait`;
}

function ensureWaitingDirectory(directory: string): void {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  platform.assertDirectorySafety(lstatSync(directory), directory);
}

function hasWaitingDirectory(directory: string): boolean {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return false;
  platform.assertDirectorySafety(stat, directory);
  return true;
}

function waitingRecordPaths(directory: string): string[] {
  try {
    if (!hasWaitingDirectory(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && RECORD_NAME.test(entry.name))
      .map(({ name }) => join(directory, name));
  } catch (error) {
    if (!isMissing(error)) throw error;
    return [];
  }
}

function processStartTime(pid: number): string | undefined {
  if (platform.windows) {
    const observation = inspectWindowsProcess(pid);
    return observation.state === "live" ? observation.identity.creationTime : undefined;
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return;
    throw new Error(`Cannot inspect reload process ${pid}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const nameEnd = stat.lastIndexOf(")");
  const fields = stat.slice(nameEnd + 2).split(" ");
  const [state] = fields;
  const started = fields[PROC_START_TIME_INDEX];
  if (nameEnd < 0 || !state || !started || !PROCESS_START_TIME.test(started))
    throw new Error(`Invalid process identity for reload process ${pid}`);
  if (!["Z", "X", "x"].includes(state)) return started;
}

function readLiveRecord(path: string): ReloadWaitingRecord | undefined {
  let encoded: string;
  try {
    encoded = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  let record: unknown;
  try {
    record = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  if (
    !isRecord(record) ||
    !isReloadBasis(record.basis) ||
    !isPositivePid(record.pid) ||
    typeof record.started !== "string" ||
    !(platform.windows
      ? isWindowsProcessIdentity({ pid: record.pid, creationTime: record.started })
      : PROCESS_START_TIME.test(record.started)) ||
    !Array.isArray(record.targets) ||
    !record.targets.length ||
    !record.targets.every(isReloadWaitingTarget) ||
    processStartTime(record.pid) !== record.started
  )
    return;
  return {
    basis: record.basis,
    pid: record.pid,
    started: record.started,
    targets: record.targets,
  };
}

function isReloadWaitingTarget(target: unknown): target is ReloadWaitingTarget {
  return (
    isRecord(target) &&
    typeof target.id === "string" &&
    SESSION_ID_PATTERN.test(target.id) &&
    typeof target.session === "string" &&
    /^\$\d+$/.test(target.session) &&
    (platform.windows
      ? typeof target.name === "string" && Boolean(target.name)
      : target.name === undefined)
  );
}

function isPositivePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function isReloadBasis(basis: unknown): basis is ReloadBasis {
  return platform.windows
    ? isWindowsManagementBasis(basis)
    : isRecord(basis) &&
        isPositivePid(basis.pid) &&
        typeof basis.generation === "string" &&
        Boolean(basis.generation);
}

function matchesBasis(expected: ReloadBasis, current: ReloadBasis): boolean {
  if ("instance" in expected && "instance" in current)
    return launchBasisStillLive(expected, current);
  return (
    "generation" in expected &&
    "generation" in current &&
    expected.generation === current.generation &&
    expected.pid === current.pid
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function removeOptionalRecord(path: string): boolean {
  try {
    unlinkIfPresent(path);
    return true;
  } catch {
    return false;
  }
}
