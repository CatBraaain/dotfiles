import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { quote } from "shell-quote";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type SessionState = "running" | "waiting-approval" | "waiting-user";

export const PANE_OPTION_NAME = "@pi_session_state";
export const OPTION_VALUE_VERSION = 1;

export interface ManagedPaneBinding {
  socketPath: string;
  serverPid: number;
  paneId: string;
  token: string;
  pid: number;
}

export type BashRunner = (command: string) => Promise<ExecResult>;

export type ManagedPaneDetection =
  | { status: "managed"; binding: ManagedPaneBinding }
  | { status: "unmanaged" }
  | { status: "failed"; message: string };

export type PublicationOutcome =
  | { status: "published" }
  | { status: "busy" }
  | { status: "failed"; message: string };

export function launchToken(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env.PI_TMUX_LAUNCH_TOKEN;
  if (existing !== undefined && existing !== "") return existing;
  const token = randomUUID();
  env.PI_TMUX_LAUNCH_TOKEN = token;
  return token;
}

export function dedicatedSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
): string {
  if (platform === "win32") return join(homedir(), ".local", "state", "pi-tmux", "server.sock");
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtimeDir)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  return join(runtimeDir, "pi-tmux", "server.sock");
}

export function stateOptionValue(
  sessionId: string,
  state: SessionState,
  title: string | null = null,
): string {
  return JSON.stringify({ version: OPTION_VALUE_VERSION, sessionId, state, title });
}

export function tmuxCommandLine(socketPath: string, args: string[]): string {
  if (!isAbsolute(socketPath)) throw new Error("tmux socket path must be absolute");
  return quote(["tmux", "-S", socketPath, ...args]);
}

export function stateCommand(
  binding: ManagedPaneBinding,
  sessionId: string,
  args: string[],
): string {
  const source = {
    socket: binding.socketPath,
    serverPid: binding.serverPid,
    pane: binding.paneId,
    pid: binding.pid,
    token: binding.token,
  };
  return quote(["pi-mux", "state", sessionId, ...args, "--source", JSON.stringify(source)]);
}

export async function detectManagedPane(
  run: BashRunner,
  env: NodeJS.ProcessEnv = process.env,
  selfPid: number = process.pid,
  platform: NodeJS.Platform | string = process.platform,
): Promise<ManagedPaneDetection> {
  try {
    if (!env.TMUX) return { status: "unmanaged" };
    const windows = platform === "win32";
    const socketPath = dedicatedSocketPath(env, platform);
    const [tmuxSocket] = env.TMUX.split(",");
    const paneId = env.TMUX_PANE;
    if (tmuxSocket !== socketPath) return { status: "unmanaged" };
    if (!paneId || !/^%\d+$/.test(paneId)) return { status: "unmanaged" };
    if (!windows && !statSync(socketPath, { throwIfNoEntry: false })?.isSocket())
      return { status: "unmanaged" };
    const inspectFormat = "#{socket_path}\t#{pid}\t#{pane_id}\t#{@pi-mux-launch}\t#{pane_pid}";
    const outcome = await run(
      tmuxCommandLine(socketPath, ["display-message", "-p", "-t", paneId, inspectFormat]),
    );
    const failure = processFailure(outcome);
    if (failure !== undefined) return { status: "failed", message: failure };
    const fields = outcome.stdout.trimEnd().split("\t");
    const [actualSocket, actualServerPid, actualPaneId, launch, actualPanePid] = fields;
    const recorded = launchRecordToken(launch);
    const isVerified =
      fields.length === 5 &&
      actualSocket === socketPath &&
      /^[1-9]\d*$/.test(actualServerPid ?? "") &&
      actualPaneId === paneId &&
      (recorded === undefined || recorded === env.PI_TMUX_LAUNCH_TOKEN);
    if (!isVerified) return { status: "unmanaged" };
    return {
      status: "managed",
      binding: {
        socketPath,
        serverPid: Number(actualServerPid),
        paneId,
        token: launchToken(env),
        pid: selfPid,
      },
    };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

export async function publishState(
  run: BashRunner,
  binding: ManagedPaneBinding,
  sessionId: string,
  state: SessionState,
  title: string | null = null,
): Promise<PublicationOutcome> {
  try {
    const result = await run(
      stateCommand(binding, sessionId, [state, "--title", JSON.stringify(title)]),
    );
    return executionFailure(result) ?? { status: "published" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

export async function unsetStateOption(
  run: BashRunner,
  binding: ManagedPaneBinding,
  sessionId: string,
): Promise<PublicationOutcome> {
  try {
    const result = await run(stateCommand(binding, sessionId, ["--clear"]));
    return executionFailure(result) ?? { status: "published" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
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

function executionFailure(result: ExecResult): PublicationOutcome | undefined {
  if (!result.killed && !("truncated" in result && result.truncated === true) && result.code === 75)
    return { status: "busy" };
  const failure = processFailure(result);
  return failure === undefined ? undefined : { status: "failed", message: failure };
}

function processFailure(result: ExecResult): string | undefined {
  if (result.killed) return "Process was interrupted or timed out";
  if ("truncated" in result && result.truncated === true) return "Process output was truncated";
  if (result.code !== 0)
    return result.stderr || result.stdout || `Process exited with code ${result.code}`;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
