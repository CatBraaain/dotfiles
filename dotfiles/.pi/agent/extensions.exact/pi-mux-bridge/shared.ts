import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";

export type TmuxPaths = ReturnType<typeof getTmuxPaths>;
export type Execute = ExtensionAPI["exec"];
export const PARENT_PI_ENV_KEYS = [
  "PI_TMUX_SESSION_ID",
  "PI_TMUX_STARTUP_COMMAND",
  "PI_TMUX_STARTUP_MODE",
  "PI_TMUX_LAUNCH_TOKEN",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];
const TMUX_TIMEOUT_MS = 5_000;

export function launchToken(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.PI_TMUX_LAUNCH_TOKEN;
  if (existing !== undefined && existing !== "") return existing;
  const token = randomUUID();
  env.PI_TMUX_LAUNCH_TOKEN = token;
  return token;
}

export function getTmuxPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
) {
  if (platform === "win32") {
    const directory = join(homedir(), ".local", "state", "pi-tmux");
    return {
      directory,
      socketPath: join(directory, "server.sock"),
      configPath: join(homedir(), ".config", "tmux", "pi.conf"),
    };
  }
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

export type ManagedPaneIdentity = { pane: string; pid: number; serverPid: number };

export async function inspectManagedPane(
  execute: Execute,
  paths: TmuxPaths,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<ManagedPaneIdentity | undefined> {
  const [socket] = (env.TMUX ?? "").split(",");
  if (socket !== paths.socketPath || !env.TMUX_PANE) return undefined;
  const result = await execute(
    "tmux",
    tmuxArgs(paths, [
      "display-message",
      "-p",
      "-t",
      env.TMUX_PANE,
      "#{socket_path}\t#{pid}\t#{pane_id}\t#{@pi-mux-launch}\t#{pane_pid}",
    ]),
    { timeout: TMUX_TIMEOUT_MS },
  );
  if (result.code !== 0 || result.killed || ("truncated" in result && result.truncated))
    throw new Error(`Cannot verify pi-mux pane: ${result.stderr.trim()}`);
  const [actualSocket, serverPid, pane, launch, pid] = result.stdout.trimEnd().split("\t");
  const recorded = launchRecordToken(launch);
  const verified =
    (actualSocket === paths.socketPath ||
      (platform === "win32" &&
        actualSocket !== undefined &&
        win32.normalize(actualSocket).toLowerCase() ===
          win32.normalize(paths.socketPath).toLowerCase())) &&
    pane === env.TMUX_PANE &&
    (recorded === undefined || recorded === env.PI_TMUX_LAUNCH_TOKEN);
  return verified && pane ? { pane, pid: Number(pid), serverPid: Number(serverPid) } : undefined;
}

function launchRecordToken(launch: string | undefined): string | undefined {
  if (!launch) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(launch);
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const token = (record as { token?: unknown }).token;
  return typeof token === "string" ? token : undefined;
}
