import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { errorMessage, isEpochMs, isRecord } from "./guards";

const QUERY_TIMEOUT_MS = 10_000;
const SAVED_HISTORY_TIMEOUT_MS = 180_000;
const VIEW_TARGET_TIMEOUT_MS = 2_000;
const SWITCH_TARGET_MISSING_EXIT_CODE = 2;
const SWITCH_CLIENT_MISSING_EXIT_CODE = 3;
const QUERY_COMMANDS = new Set(["list", "switch", "metadata", "record-view"]);

export interface PiMuxViewTarget {
  file: string;
  fileIdentity: string;
  responseId: string | null;
}

export interface PiSession {
  sessionId: string;
  cwd: string;
  temporary?: true;
}

export interface PiRuntime extends PiSession {
  target: string;
}

export interface PiMuxSession {
  id: string;
  file: string;
  state: string | null;
  title: string | null;
  /** Last state publication attempt that pi-mux has not applied yet; null when none. */
  publishPending?: PiMuxPublishPending | null;
  lastRun?: PiMuxLastRun;
  reloadStatus?: "waiting-reload";
  temporary?: true;
}

export interface PiMuxLastRun {
  atMs: number;
  aborted: boolean;
}

/** `publishPending` item: the publication was attempted at `attemptAt` (Unix epoch ms). */
export interface PiMuxPublishPending {
  attemptAt: number;
}

/** A running Pi whose conversation file is not created yet (list `empty` section). */
export interface PiMuxEmptySession {
  id: string;
  file: string;
  temporary?: true;
}

export interface PiMuxWorkspace {
  cwd: string;
  sessions: PiMuxSession[];
  empty: PiMuxEmptySession[];
}

export interface PiMuxCurrentSession {
  id: string;
  cwd: string;
  file: string;
  target: string;
}

export interface PiMuxHistoryEntry {
  source: "normal" | "live-archive";
  id: string;
  cwd: string;
  file: string;
  title: string | null;
  btime: number | null;
  /** Latest message/compaction entry timestamp; null when the file has none. */
  mtime: number | null;
  size: number;
}

export function flattenPiMuxSessions(workspaces: readonly PiMuxWorkspace[]) {
  return workspaces.flatMap(({ cwd, sessions }) =>
    sessions.map((session) => ({ ...session, cwd })),
  );
}

/** Whether the session is attachable: saved live sessions and unsaved empty ones count. */
export function hasLiveSession(workspaces: readonly PiMuxWorkspace[], sessionId: string): boolean {
  return workspaces.some(
    ({ sessions, empty }) =>
      sessions.some((session) => session.id === sessionId) ||
      empty.some((session) => session.id === sessionId),
  );
}

export class PiMux {
  constructor(
    private readonly execute: (
      executable: string,
      args: string[],
      cwd?: string,
    ) => Promise<string> = executePiMux,
  ) {}

  async newSession(cwd: string): Promise<string> {
    const output = await this.command(["new", "--detached"], cwd);
    const match = /^Pi session (\S+)\r?$/.exec(output.split("\n")[0]);
    if (match === null) throw new Error(`Invalid pi-mux new response in ${cwd}: ${output}`);
    return match[1];
  }

  async registerWorkspace(cwd: string): Promise<void> {
    await this.command(["workspace", "register", cwd]);
  }

  async unregisterWorkspace(cwd: string): Promise<void> {
    await this.command(["workspace", "unregister", cwd]);
  }

  async reloadAllSessions(): Promise<void> {
    await this.command(["reload"]);
  }

  async reloadSession(sessionId: string): Promise<void> {
    const output = await this.command(["reload", sessionId]);
    if (!output.split(/\r?\n/).includes(`reloaded ${sessionId}`))
      throw new Error("pi-mux did not report a completed reload");
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.command(["close", sessionId]);
  }

  async closeTemporarySession(sessionId: string): Promise<void> {
    await this.command(["close", "--if-temporary", sessionId]);
  }

  async list(): Promise<PiMuxWorkspace[]> {
    const output = await this.command(["list", "--active", "--json"]);
    const workspaces: unknown = JSON.parse(output);
    if (!Array.isArray(workspaces) || !workspaces.every(isPiMuxWorkspace)) {
      throw new Error("Invalid pi-mux list response");
    }
    return workspaces.map((workspace) => ({
      ...workspace,
      sessions: workspace.sessions.map(({ lastRun, reloadStatus, ...session }) => ({
        ...session,
        ...(isPiMuxLastRun(lastRun) ? { lastRun } : {}),
        ...(reloadStatus === "waiting-reload" ? { reloadStatus } : {}),
      })),
    }));
  }

  async aliveSessionIds(sessionIds: readonly string[]): Promise<Set<string> | null> {
    try {
      const workspaces = await this.list();
      return new Set(sessionIds.filter((id) => hasLiveSession(workspaces, id)));
    } catch {
      return null;
    }
  }

  async switch(
    sessionId: string,
    clientPid?: number,
  ): Promise<"switched" | "target-missing" | "client-missing"> {
    const args = ["switch", sessionId, ...clientPidArgs(clientPid)];
    try {
      await this.execute("pi-mux", args, undefined);
      return "switched";
    } catch (error) {
      if (isRecord(error) && error.exitCode === SWITCH_TARGET_MISSING_EXIT_CODE)
        return "target-missing";
      if (isRecord(error) && error.exitCode === SWITCH_CLIENT_MISSING_EXIT_CODE)
        return "client-missing";
      throw new Error(`pi-mux ${args.join(" ")}: ${errorMessage(error)}`);
    }
  }

  async current(clientPid: number): Promise<PiMuxCurrentSession | undefined> {
    const output = await this.command([
      "list",
      "--displayed",
      "--json",
      ...clientPidArgs(clientPid),
    ]);
    const sessions = parseJsonOutput(output, "list --displayed");
    if (!Array.isArray(sessions)) throw new Error("Invalid pi-mux list --displayed response");
    if (sessions.length === 0) return undefined;
    if (sessions.length > 1) {
      throw new Error(`pi-mux list --displayed returned multiple sessions for PID ${clientPid}`);
    }
    const [session] = sessions;
    if (!isPiMuxDisplayedSession(session))
      throw new Error("Invalid pi-mux list --displayed response");
    const { id, cwd, file, target } = session;
    return { id, cwd, file, target };
  }

  async sessionWorktrees(sessionId: string, cwd: string): Promise<string[] | undefined> {
    const args = ["metadata", sessionId];
    let output: string;
    try {
      output = await this.execute("pi-mux", args, cwd);
    } catch (error) {
      const notFound = `pi-mux: Saved session not found (use the complete ID): ${sessionId}`;
      if (isRecord(error) && error.exitCode === 1 && error.stderr === notFound) return undefined;
      throw new Error(`pi-mux ${args.join(" ")} in ${cwd}: ${errorMessage(error)}`);
    }

    const response = parseJsonOutput(output, "metadata");
    if (!isRecord(response) || response.id !== sessionId || !isWorktreePaths(response.worktrees))
      throw new Error("Invalid pi-mux metadata response");
    return response.worktrees;
  }

  async viewTarget(sessionId: string, file: string): Promise<PiMuxViewTarget> {
    const output = await this.command(["metadata", "--view-target", sessionId, file]);
    const target = parseJsonOutput(output, "metadata --view-target");
    if (
      !isRecord(target) ||
      typeof target.file !== "string" ||
      !isAbsolute(target.file) ||
      target.file.includes("\0") ||
      (target.responseId !== null &&
        (typeof target.responseId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(target.responseId))) ||
      typeof target.fileIdentity !== "string" ||
      !/^\d+:\d+:-?\d+$/.test(target.fileIdentity)
    )
      throw new Error("Invalid pi-mux view target response");
    return { file: target.file, fileIdentity: target.fileIdentity, responseId: target.responseId };
  }

  async recordView(sessionId: string, target: PiMuxViewTarget, viewedAtMs: number): Promise<void> {
    const receipt = { ...target, viewedAt: new Date(viewedAtMs).toISOString() };
    await this.command(["record-view", sessionId, JSON.stringify(receipt)]);
  }

  async history(): Promise<PiMuxHistoryEntry[]> {
    const output = await this.command(["list", "--json"]);
    return parseHistoryEntries(parseJsonOutput(output, "list --json"));
  }

  private async command(args: string[], cwd?: string): Promise<string> {
    try {
      return await this.execute("pi-mux", args, cwd);
    } catch (error) {
      throw new Error(`pi-mux ${args.join(" ")}${cwd ? ` in ${cwd}` : ""}: ${errorMessage(error)}`);
    }
  }
}

function clientPidArgs(clientPid: number | undefined): string[] {
  return clientPid === undefined ? [] : ["--client-pid", String(clientPid)];
}

/** Parse command stdout as JSON; invalid JSON is an invalid response, not a CLI failure. */
function parseJsonOutput(output: string, command: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Invalid pi-mux ${command} response`);
  }
}

type PiMuxSessionPayload = Omit<PiMuxSession, "lastRun" | "reloadStatus"> & {
  lastRun?: unknown;
  reloadStatus?: unknown;
};
type PiMuxWorkspacePayload = Omit<PiMuxWorkspace, "sessions"> & { sessions: PiMuxSessionPayload[] };

function isPiMuxWorkspace(workspace: unknown): workspace is PiMuxWorkspacePayload {
  return (
    isRecord(workspace) &&
    typeof workspace.cwd === "string" &&
    isAbsolute(workspace.cwd) &&
    Array.isArray(workspace.sessions) &&
    workspace.sessions.every(isPiMuxSession) &&
    Array.isArray(workspace.empty) &&
    workspace.empty.every(isPiMuxEmptySession)
  );
}

function isPiMuxSession(session: unknown): session is PiMuxSessionPayload {
  return (
    isRecord(session) &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.file === "string" &&
    isAbsolute(session.file) &&
    (session.state === null || typeof session.state === "string") &&
    (session.title === null || typeof session.title === "string") &&
    (!Object.hasOwn(session, "publishPending") || isPiMuxPublishPending(session.publishPending)) &&
    (!Object.hasOwn(session, "temporary") || session.temporary === true)
  );
}

function isPiMuxLastRun(value: unknown): value is PiMuxLastRun {
  return isRecord(value) && isEpochMs(value.atMs) && typeof value.aborted === "boolean";
}

function isPiMuxPublishPending(value: unknown): value is PiMuxPublishPending | null {
  return value === null || (isRecord(value) && isEpochMs(value.attemptAt));
}

function isPiMuxEmptySession(session: unknown): session is PiMuxEmptySession {
  return (
    isRecord(session) &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.file === "string" &&
    isAbsolute(session.file) &&
    (!Object.hasOwn(session, "temporary") || session.temporary === true)
  );
}

function isPiMuxDisplayedSession(
  session: unknown,
): session is PiMuxCurrentSession & { clientPid: number } {
  return (
    isRecord(session) &&
    typeof session.clientPid === "number" &&
    Number.isSafeInteger(session.clientPid) &&
    session.clientPid > 0 &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.cwd === "string" &&
    isAbsolute(session.cwd) &&
    typeof session.file === "string" &&
    isAbsolute(session.file) &&
    typeof session.target === "string" &&
    session.target.length > 0
  );
}

function isWorktreePaths(paths: unknown): paths is string[] {
  return (
    Array.isArray(paths) &&
    paths.every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0")) &&
    new Set(paths).size === paths.length
  );
}

function parseHistoryEntries(workspaces: unknown): PiMuxHistoryEntry[] {
  const invalidResponse = "Invalid pi-mux list --json response";
  if (!Array.isArray(workspaces)) throw new Error(invalidResponse);
  const entries: PiMuxHistoryEntry[] = [];
  for (const workspace of workspaces) {
    if (
      !isRecord(workspace) ||
      !isAbsoluteHistoryPath(workspace.cwd) ||
      !Array.isArray(workspace.sessions)
    )
      throw new Error(invalidResponse);
    for (const session of workspace.sessions) {
      if (!isRecord(session)) throw new Error(invalidResponse);
      const { id, file, btime, mtime, size, history } = session;
      if (typeof id !== "string" || id.length === 0 || !isAbsoluteHistoryPath(file))
        throw new Error(invalidResponse);
      if (!Object.hasOwn(session, "history")) {
        if (session.active !== true) throw new Error(invalidResponse);
        continue;
      }
      if (
        !isRecord(history) ||
        (history.source !== "normal" && history.source !== "live-archive") ||
        !isAbsoluteHistoryPath(history.cwd) ||
        (history.title !== null && typeof history.title !== "string") ||
        !isHistoryTime(btime) ||
        !isHistoryTime(mtime) ||
        typeof size !== "number" ||
        !Number.isFinite(size)
      )
        throw new Error(invalidResponse);
      entries.push({
        id,
        file,
        btime,
        mtime,
        size,
        cwd: history.cwd,
        title: history.title,
        source: history.source,
      });
    }
  }
  return entries;
}

function isAbsoluteHistoryPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function isHistoryTime(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function commandTimeoutMs([command, mode]: string[]): number {
  if (command === "list" && mode === "--json") return SAVED_HISTORY_TIMEOUT_MS;
  if (command === "metadata" && mode === "--view-target") return VIEW_TARGET_TIMEOUT_MS;
  return QUERY_COMMANDS.has(command) ? QUERY_TIMEOUT_MS : 0;
}

async function executePiMux(executable: string, args: string[], cwd?: string): Promise<string> {
  const timeoutMs = commandTimeoutMs(args);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        COLORTERM: process.env.COLORTERM ?? "truecolor",
        TMUX: undefined,
        TMUX_PANE: undefined,
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(
        Object.assign(new Error(describeFailure(executable, child, stderr, timeoutMs)), {
          exitCode,
          stderr,
        }),
      );
    });
  });
}

function describeFailure(
  executable: string,
  child: ChildProcess,
  stderr: string,
  timeoutMs: number,
): string {
  const outcome =
    timeoutMs > 0 && child.killed && child.signalCode === "SIGTERM"
      ? `timed out after ${timeoutMs} ms`
      : child.signalCode !== null
        ? `terminated by ${child.signalCode}`
        : `exited with ${child.exitCode}`;
  const summary = `${executable} ${outcome}`;
  return stderr === "" ? summary : `${stderr} (${summary})`;
}
