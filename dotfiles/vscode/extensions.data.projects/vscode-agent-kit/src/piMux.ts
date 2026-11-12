import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { errorMessage, isRecord } from "./guards";

const executeFile = promisify(execFile);

export interface PiSession {
  sessionId: string;
  cwd: string;
  temporary?: true;
}

export interface PiMuxSession {
  id: string;
  file: string;
  state: string | null;
  title: string | null;
  temporary?: true;
}

export interface PiMuxWorkspace {
  cwd: string;
  sessions: PiMuxSession[];
}

export function flattenPiMuxSessions(workspaces: readonly PiMuxWorkspace[]) {
  return workspaces.flatMap(({ cwd, sessions }) =>
    sessions.map((session) => ({ ...session, cwd })),
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
      const liveIds = new Set(flattenPiMuxSessions(await this.list()).map((session) => session.id));
      return new Set(sessionIds.filter((id) => liveIds.has(id)));
    } catch {
      return null;
    }
  }

  private async command(args: string[], cwd?: string): Promise<string> {
    try {
      return await this.execute("pi-mux", args, cwd);
    } catch (error) {
      throw new Error(`pi-mux ${args.join(" ")}${cwd ? ` in ${cwd}` : ""}: ${errorMessage(error)}`);
    }
  }
}

function isPiMuxWorkspace(workspace: unknown): workspace is PiMuxWorkspace {
  return (
    isRecord(workspace) &&
    typeof workspace.cwd === "string" &&
    isAbsolute(workspace.cwd) &&
    Array.isArray(workspace.sessions) &&
    workspace.sessions.every(isPiMuxSession)
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

async function executePiMux(executable: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await executeFile(executable, args, {
    cwd,
    timeout: args[0] === "list" ? 10_000 : 0,
    env: {
      ...process.env,
      COLORTERM: process.env.COLORTERM ?? "truecolor",
      TMUX: undefined,
      TMUX_PANE: undefined,
    },
  });
  return stdout;
}
