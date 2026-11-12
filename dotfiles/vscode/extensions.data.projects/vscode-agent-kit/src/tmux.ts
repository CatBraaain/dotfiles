import { execFile } from "node:child_process";
import { getuid } from "node:process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { errorMessage, isRecord } from "./guards";
import type { PiSession } from "./piMux";

const executeFile = promisify(execFile);

export interface PiRuntime extends PiSession {
  target: string;
}

export interface TmuxClient {
  pid: number;
  parentPid?: number;
  name: string;
  target: string;
}

export function piMuxSocketPath(): string {
  return join(process.env.XDG_RUNTIME_DIR || `/run/user/${getuid!()}`, "pi-tmux", "server.sock");
}

export class TmuxRuntimeStore {
  constructor(
    readonly socketPath: string,
    private readonly execute: (executable: string, args: string[]) => Promise<string> = executeTmux,
  ) {}

  async resolveTarget(sessionId: string): Promise<string | undefined> {
    const panes = await this.query([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{@pi-tmux-session}",
    ]);
    for (const line of panes.split("\n")) {
      const [target, encoded] = line.split("\t");
      if (!target || !encoded) continue;
      try {
        const metadata: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (isRecord(metadata) && metadata.id === sessionId) return target;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async resolveSession(target: string): Promise<(PiRuntime & { file: string }) | undefined> {
    const panes = await this.query([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{@pi-tmux-session}",
    ]);
    for (const line of panes.split("\n")) {
      const [name, encoded] = line.split("\t");
      if (name !== target || !encoded) continue;
      try {
        const metadata: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (
          isRecord(metadata) &&
          typeof metadata.id === "string" &&
          metadata.id.length > 0 &&
          typeof metadata.cwd === "string" &&
          isAbsolute(metadata.cwd) &&
          typeof metadata.file === "string" &&
          isAbsolute(metadata.file)
        )
          return { sessionId: metadata.id, cwd: metadata.cwd, file: metadata.file, target };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  async clients(): Promise<TmuxClient[]> {
    const clients = await this.query([
      "list-clients",
      "-F",
      "#{client_pid}\t#{client_name}\t#{session_name}",
    ]);
    return await Promise.all(
      clients
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(async (line) => {
          const [pid, name, target] = line.split("\t");
          const client = { pid: Number(pid), name, target };
          try {
            const status = await readFile(`/proc/${client.pid}/status`, "utf8");
            const parentPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
            return { ...client, parentPid };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return client;
            throw error;
          }
        }),
    );
  }

  async switchClient(client: TmuxClient, runtime: PiRuntime): Promise<void> {
    await this.command(["switch-client", "-c", client.name, "-t", `=${runtime.target}`]);
  }

  private async query(args: string[]): Promise<string> {
    try {
      return await this.command(args);
    } catch (error) {
      if (
        isMissingServer(error) ||
        /(?:^|:\s|\n)(?:no current target|no sessions)\s*$/.test(errorMessage(error))
      )
        return "";
      throw error;
    }
  }

  private async command(args: string[]): Promise<string> {
    const escapedArgs = args.map((argument) =>
      argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument,
    );
    try {
      return await this.execute("tmux", ["-S", this.socketPath, ...escapedArgs]);
    } catch (error) {
      throw new Error(`tmux ${args[0]} (${this.socketPath}): ${errorMessage(error)}`);
    }
  }
}

function isMissingServer(error: unknown): boolean {
  return /no server running|error connecting to .*No such file or directory/.test(
    errorMessage(error),
  );
}

async function executeTmux(executable: string, args: string[]): Promise<string> {
  const { stdout } = await executeFile(executable, args, {
    timeout: 10_000,
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
  });
  return stdout;
}
