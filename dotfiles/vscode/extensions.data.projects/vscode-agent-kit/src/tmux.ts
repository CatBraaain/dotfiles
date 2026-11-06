import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./guards";

const executeFile = promisify(execFile);

export interface PiRuntime {
  sessionId: string;
  target: string;
  cwd: string;
}

export interface PiLaunch {
  sessionId: string;
  cwd: string;
  args: string[];
}

export interface TmuxClient {
  pid: number;
  name: string;
  target: string;
}

export function tmuxSocketName(agentDir: string, sessionDir: string): string {
  return `pi-sessions-${digest(JSON.stringify([resolve(agentDir), resolve(sessionDir)]))}`;
}

export class TmuxRuntimeStore {
  readonly executable = "tmux";

  constructor(
    readonly socketName: string,
    private readonly execute: (executable: string, args: string[]) => Promise<string> = executeTmux,
  ) {}

  get connectionArgs(): string[] {
    return ["-L", this.socketName, "-f", "/dev/null"];
  }

  async ensure(launch: PiLaunch): Promise<PiRuntime> {
    const runtime = this.runtime(launch.sessionId, launch.cwd);
    if (!(await this.isAlive(runtime))) {
      try {
        await this.command(
          [
            "new-session",
            "-d",
            "-s",
            runtime.target,
            "-c",
            launch.cwd,
            ...this.launchEnvironment(),
            "pi",
            ...launch.args,
          ],
          ["set-option", "-t", runtime.target, "status", "off"],
          ["set-option", "-s", "extended-keys", "on"],
          ["set-option", "-t", runtime.target, "prefix", "None"],
        );
      } catch (error) {
        if (!/duplicate session/.test(errorMessage(error)) || !(await this.isAlive(runtime)))
          throw error;
      }
      await this.enableCsiUExtendedKeysFormat();
      if (!(await this.isAlive(runtime))) {
        throw new Error(`Pi exited while starting session ${launch.sessionId} in ${launch.cwd}`);
      }
    }
    await this.command(
      ["set-option", "-t", runtime.target, "set-titles", "on"],
      ["set-option", "-t", runtime.target, "set-titles-string", "#{pane_title}"],
    );
    return runtime;
  }

  private async enableCsiUExtendedKeysFormat(): Promise<void> {
    // tmux lacks extended-keys-format before 3.5; pi still reads the xterm format there
    try {
      await this.command(["set-option", "-s", "extended-keys-format", "csi-u"]);
    } catch (error) {
      if (!/invalid option|unknown option/.test(errorMessage(error))) throw error;
    }
  }

  async isAlive(runtime: PiRuntime): Promise<boolean> {
    const panes = await this.query(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"]);
    return panes.split("\n").some((line) => line === `${runtime.target}\t0`);
  }

  async clients(): Promise<TmuxClient[]> {
    const clients = await this.query([
      "list-clients",
      "-F",
      "#{client_pid}\t#{client_name}\t#{session_name}",
    ]);
    return clients
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, name, target] = line.split("\t");
        return { pid: Number(pid), name, target };
      });
  }

  async switchClient(client: TmuxClient, runtime: PiRuntime): Promise<void> {
    await this.command(["switch-client", "-c", client.name, "-t", runtime.target]);
  }

  private runtime(sessionId: string, cwd: string): PiRuntime {
    return { sessionId, cwd, target: `pi-${digest(sessionId)}` };
  }

  private launchEnvironment(): string[] {
    return ["PATH", "HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : ["-e", `${key}=${process.env[key]}`],
    );
  }

  private async query(args: string[]): Promise<string> {
    try {
      return await this.command(args);
    } catch (error) {
      if (
        /no server running|error connecting to .*No such file or directory/.test(
          errorMessage(error),
        )
      )
        return "";
      throw error;
    }
  }

  private async command(args: string[], ...followingCommands: string[][]): Promise<string> {
    const commandArgs = [args, ...followingCommands].flatMap((command, index) => {
      const escapedArgs = command.map(escapeTmuxArgument);
      return index === 0 ? escapedArgs : [";", ...escapedArgs];
    });
    try {
      return await this.execute(this.executable, [...this.connectionArgs, ...commandArgs]);
    } catch (error) {
      throw new Error(
        `tmux ${args[0]} (${this.socketName}, ${commandArgs.join(" ")}): ${errorMessage(error)}`,
      );
    }
  }
}

function escapeTmuxArgument(argument: string): string {
  return argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument;
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

async function executeTmux(executable: string, args: string[]): Promise<string> {
  const { stdout } = await executeFile(executable, args, {
    timeout: 10_000,
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
  });
  return stdout;
}
