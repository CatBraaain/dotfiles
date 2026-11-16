import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { errorMessage, isRecord } from "./guards";

const QUERY_TIMEOUT_MS = 10_000;
const QUERY_COMMANDS = new Set(["list", "history", "current", "switch"]);

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
  temporary?: true;
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

/** `pi-mux current` response: the session a tmux client displays right now. */
export interface PiMuxCurrentSession {
  id: string;
  cwd: string;
  file: string;
  target: string;
}

/** `pi-mux history` entry: one saved conversation file. */
export interface PiMuxHistoryEntry {
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

  async closeSession(sessionId: string): Promise<void> {
    await this.command(["close", sessionId]);
  }

  async closeTemporarySession(sessionId: string): Promise<void> {
    await this.command(["close", "--if-temporary", sessionId]);
  }

  async list(): Promise<PiMuxWorkspace[]> {
    const output = await this.command(["list"]);
    const workspaces: unknown = JSON.parse(output);
    if (!Array.isArray(workspaces) || !workspaces.every(isPiMuxWorkspace)) {
      throw new Error("Invalid pi-mux list response");
    }
    return workspaces;
  }

  async aliveSessionIds(sessionIds: readonly string[]): Promise<Set<string> | null> {
    try {
      const workspaces = await this.list();
      return new Set(sessionIds.filter((id) => hasLiveSession(workspaces, id)));
    } catch {
      return null;
    }
  }

  /** Switch a tmux client to a session. False means the session or client was not found. */
  async switch(sessionId: string, clientPid?: number): Promise<boolean> {
    const args = ["switch", sessionId, ...clientPidArgs(clientPid)];
    try {
      await this.execute("pi-mux", args, undefined);
      return true;
    } catch (error) {
      if (isCliUnavailable(error))
        throw new Error(`pi-mux ${args.join(" ")}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Resolve the session a tmux client displays. Undefined when it cannot be resolved. */
  async current(clientPid?: number): Promise<PiMuxCurrentSession | undefined> {
    const args = ["current", ...clientPidArgs(clientPid)];
    let output: string;
    try {
      output = await this.execute("pi-mux", args, undefined);
    } catch (error) {
      if (isCliUnavailable(error))
        throw new Error(`pi-mux ${args.join(" ")}: ${errorMessage(error)}`);
      return undefined;
    }
    const session: unknown = parseJsonOutput(output, "current");
    if (!isPiMuxCurrentSession(session)) throw new Error("Invalid pi-mux current response");
    return session;
  }

  /** List saved conversations, newest first. Throws when the CLI fails. */
  async history(cwd?: string): Promise<PiMuxHistoryEntry[]> {
    const output = await this.command(["history", ...(cwd === undefined ? [] : ["--cwd", cwd])]);
    const entries: unknown = parseJsonOutput(output, "history");
    if (!Array.isArray(entries) || !entries.every(isPiMuxHistoryEntry)) {
      throw new Error("Invalid pi-mux history response");
    }
    return entries;
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

function isCliUnavailable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPiMuxWorkspace(workspace: unknown): workspace is PiMuxWorkspace {
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

function isPiMuxSession(session: unknown): session is PiMuxSession {
  return (
    isRecord(session) &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.file === "string" &&
    isAbsolute(session.file) &&
    (session.state === null || typeof session.state === "string") &&
    (session.title === null || typeof session.title === "string") &&
    (!Object.hasOwn(session, "temporary") || session.temporary === true)
  );
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

function isPiMuxCurrentSession(session: unknown): session is PiMuxCurrentSession {
  return (
    isRecord(session) &&
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

function isPiMuxHistoryEntry(entry: unknown): entry is PiMuxHistoryEntry {
  return (
    isRecord(entry) &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.cwd === "string" &&
    isAbsolute(entry.cwd) &&
    typeof entry.file === "string" &&
    isAbsolute(entry.file) &&
    (entry.title === null || typeof entry.title === "string") &&
    (entry.btime === null || (typeof entry.btime === "number" && Number.isFinite(entry.btime))) &&
    (entry.mtime === null || (typeof entry.mtime === "number" && Number.isFinite(entry.mtime))) &&
    typeof entry.size === "number" &&
    Number.isFinite(entry.size)
  );
}

async function executePiMux(executable: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      timeout: QUERY_COMMANDS.has(args[0]) ? QUERY_TIMEOUT_MS : 0,
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
      reject(
        new Error(describeFailure(executable, child, Buffer.concat(stderrChunks).toString("utf8"))),
      );
    });
  });
}

function describeFailure(executable: string, child: ChildProcess, stderr: string): string {
  const outcome =
    child.killed && child.signalCode === "SIGTERM"
      ? `timed out after ${QUERY_TIMEOUT_MS} ms`
      : child.signalCode !== null
        ? `terminated by ${child.signalCode}`
        : `exited with ${child.exitCode}`;
  const reason = stderr.trim();
  const summary = `${executable} ${outcome}`;
  return reason === "" ? summary : `${reason} (${summary})`;
}
