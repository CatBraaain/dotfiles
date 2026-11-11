import { readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";

export type TmuxPaths = ReturnType<typeof getTmuxPaths>;
export type Execute = ExtensionAPI["exec"];
export const PARENT_PI_ENV_KEYS = [
  "PI_TMUX_SESSION_ID",
  "PI_TMUX_STARTUP_COMMAND",
  "PI_TMUX_STARTUP_MODE",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];
const TMUX_TIMEOUT_MS = 5_000;

export function getTmuxPaths(env: NodeJS.ProcessEnv = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  const directory = join(runtime, "pi-tmux");
  return {
    directory,
    socketPath: join(directory, "server.sock"),
    configPath: join(homedir(), ".config", "tmux", "pi.conf"),
  };
}

export function tmuxArgs(paths: TmuxPaths, args: string[]): string[] {
  return ["-S", paths.socketPath, "-f", paths.configPath, ...args];
}

export function attachCommand(target: { socketPath: string; tmuxSessionId: string }): string {
  return quote(["tmux", "-S", target.socketPath, "attach-session", "-t", target.tmuxSessionId]);
}

export async function inspectManagedPane(
  execute: Execute,
  paths: TmuxPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ pane: string; pid: number } | undefined> {
  const [socket, serverPid] = (env.TMUX ?? "").split(",");
  if (socket !== paths.socketPath || !env.TMUX_PANE) return undefined;
  const result = await execute(
    "tmux",
    tmuxArgs(paths, [
      "display-message",
      "-p",
      "-t",
      env.TMUX_PANE,
      "#{socket_path}\t#{pid}\t#{pane_id}\t#{pane_tty}\t#{pane_pid}",
    ]),
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (result.code !== 0 || result.killed || ("truncated" in result && result.truncated))
    throw new Error(`Cannot verify pi-mux pane: ${result.stderr.trim()}`);
  const [actualSocket, actualServer, pane, tty, pid] = result.stdout.trimEnd().split("\t");
  const verified =
    actualSocket === paths.socketPath &&
    actualServer === serverPid &&
    pane === env.TMUX_PANE &&
    tty === readlinkSync("/proc/self/fd/0") &&
    (env.PI_TMUX_SESSION_ID
      ? Number(pid) === process.pid
      : processDescendsFrom(process.pid, Number(pid)));
  return verified && pane ? { pane, pid: Number(pid) } : undefined;
}

function processDescendsFrom(pid: number, ancestor: number): boolean {
  let current = pid;
  while (current > 0) {
    if (current === ancestor) return true;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${current}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return false;
}
