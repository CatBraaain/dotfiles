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
          ...this.settingsCommands([runtime.target]),
        );
      } catch (error) {
        if (!/duplicate session/.test(errorMessage(error)) || !(await this.isAlive(runtime)))
          throw error;
      }
      await this.enableCsiUExtendedKeysFormat();
      await this.bindShiftEnterForwarding();
      if (!(await this.isAlive(runtime))) {
        throw new Error(`Pi exited while starting session ${launch.sessionId} in ${launch.cwd}`);
      }
    }
    const [titleCommand, ...titleCommands] = this.titleCommands(runtime.target);
    await this.command(titleCommand, ...titleCommands);
    return runtime;
  }

  async reapplySettings(): Promise<number> {
    const sessions = await this.query(["list-sessions", "-F", "#{session_name}"]);
    const targets = sessions.split("\n").filter((name) => /^pi-[a-f0-9]{24}$/.test(name));
    if (targets.length === 0) return 0;

    const [firstCommand, ...commands] = this.settingsCommands(targets);
    await this.command(firstCommand, ...commands);
    await this.enableCsiUExtendedKeysFormat();
    await this.bindShiftEnterForwarding();
    return targets.length;
  }

  private settingsCommands(targets: readonly string[]): string[][] {
    return [
      ...targets.flatMap((target) => [
        ["set-option", "-t", target, "status", "off"],
        ["set-option", "-t", target, "prefix", "None"],
        ...this.titleCommands(target),
      ]),
      ["set-option", "-s", "extended-keys", "on"],
      ["unbind-key", "-T", "root", "C-MouseDrag1Pane"],
      ["unbind-key", "-T", "root", "C-MouseDrag1Empty"],
    ];
  }

  private titleCommands(target: string): string[][] {
    return [
      ["set-option", "-t", target, "set-titles", "on"],
      ["set-option", "-t", target, "set-titles-string", "#{pane_title}"],
    ];
  }

  private async enableCsiUExtendedKeysFormat(): Promise<void> {
    // tmux lacks extended-keys-format before 3.5; pi still reads the xterm format there
    try {
      await this.command(["set-option", "-s", "extended-keys-format", "csi-u"]);
    } catch (error) {
      if (!/invalid option|unknown option/.test(errorMessage(error))) throw error;
    }
  }

  private async bindShiftEnterForwarding(): Promise<void> {
    try {
      await this.command([
        "bind-key",
        "-n",
        "S-Enter",
        "send-keys",
        "-H",
        "1b",
        "5b",
        "31",
        "33",
        "3b",
        "32",
        "75",
      ]);
    } catch (error) {
      if (
        !/unknown key: S-Enter|(?:unknown|invalid) (?:flag|option)[: ]+-?H\b/.test(
          errorMessage(error),
        )
      )
        throw error;
    }
  }

  async stop(sessionId: string): Promise<string> {
    const target = runtimeTarget(sessionId);
    try {
      await this.command(["kill-session", "-t", `=${target}`]);
    } catch (error) {
      if (
        !/no server running|error connecting to .*No such file or directory|can't find session:/.test(
          errorMessage(error),
        )
      ) {
        throw error;
      }
    }
    return target;
  }

  async isAlive(runtime: PiRuntime): Promise<boolean> {
    const panes = await this.query(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"]);
    return panes.split("\n").some((line) => line === `${runtime.target}\t0`);
  }

  /** Subset of `sessionIds` whose Pi tmux session still has a live pane.
   * Returns null when tmux cannot be queried; callers then treat every
   * session's phase as unknown instead of trusting stale store entries. */
  async aliveSessionIds(sessionIds: readonly string[]): Promise<Set<string> | null> {
    let panes: string;
    try {
      panes = await this.query(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"]);
    } catch {
      return null;
    }
    const aliveTargets = new Set(
      panes
        .split("\n")
        .filter((line) => line.endsWith("\t0"))
        .map((line) => line.slice(0, -"\t0".length)),
    );
    return new Set(sessionIds.filter((sessionId) => aliveTargets.has(runtimeTarget(sessionId))));
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
    return { sessionId, cwd, target: runtimeTarget(sessionId) };
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

/** tmux session name this extension gives a Pi session id. */
function runtimeTarget(sessionId: string): string {
  return `pi-${digest(sessionId)}`;
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
