import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage, isRecord } from "./guards";

const executeFile = promisify(execFile);

export interface PiSession {
  sessionId: string;
  cwd: string;
}

export interface PiMuxSession {
  id: string;
  cwd: string;
  file: string | null;
  phase: string | null;
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

  async list(): Promise<PiMuxSession[]> {
    const output = await this.command(["list"]);
    const sessions: unknown = JSON.parse(output);
    if (!Array.isArray(sessions) || !sessions.every(isPiMuxSession)) {
      throw new Error("Invalid pi-mux list response");
    }
    return sessions;
  }

  async aliveSessionIds(sessionIds: readonly string[]): Promise<Set<string> | null> {
    try {
      const liveIds = new Set((await this.list()).map((session) => session.id));
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

function isPiMuxSession(session: unknown): session is PiMuxSession {
  return (
    isRecord(session) &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    typeof session.cwd === "string" &&
    (session.file === null || typeof session.file === "string") &&
    (session.phase === null || typeof session.phase === "string")
  );
}

async function executePiMux(executable: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await executeFile(executable, args, {
    cwd,
    timeout: args[0] === "list" ? 10_000 : 0,
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
  });
  return stdout;
}
