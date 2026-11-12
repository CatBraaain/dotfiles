import { readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { quote } from "shell-quote";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackgroundBashOutcome } from "../tools/background-bash.ts";

export type SessionState = "running" | "waiting-approval" | "waiting-user";

export const PANE_OPTION_NAME = "@pi_session_state";
export const OPTION_VALUE_VERSION = 1;

export interface ManagedPaneBinding {
  socketPath: string;
  serverPid: number;
  paneId: string;
  serverStartTime: string;
  pid: number;
  started: string;
}

export type BashRunner = (command: string) => Promise<BackgroundBashOutcome>;

export type ManagedPaneDetection =
  | { status: "managed"; binding: ManagedPaneBinding }
  | { status: "unmanaged" }
  | { status: "aborted" }
  | { status: "failed"; message: string };

export type PublicationOutcome =
  | { status: "published" }
  | { status: "busy" }
  | { status: "aborted" }
  | { status: "failed"; message: string };

export function dedicatedSocketPath(env: NodeJS.ProcessEnv = process.env): string {
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
    serverStartTime: binding.serverStartTime,
    pane: binding.paneId,
    pid: binding.pid,
    started: binding.started,
  };
  return quote(["pi-mux", "state", sessionId, ...args, "--source", JSON.stringify(source)]);
}

export function processStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!started || !/^\d+$/.test(started))
    throw new Error(`Cannot identify process start time: ${pid}`);
  return started;
}

export async function detectManagedPane(
  run: BashRunner,
  env: NodeJS.ProcessEnv = process.env,
  selfPid: number = process.pid,
): Promise<ManagedPaneDetection> {
  try {
    if (!env.TMUX) return { status: "unmanaged" };
    const socketPath = dedicatedSocketPath(env);
    const [tmuxSocket, tmuxServerPid] = env.TMUX.split(",");
    const paneId = env.TMUX_PANE;
    if (tmuxSocket !== socketPath) return { status: "unmanaged" };
    if (!paneId || !/^%\d+$/.test(paneId) || !tmuxServerPid || !/^[1-9]\d*$/.test(tmuxServerPid))
      return { status: "unmanaged" };
    if (!statSync(socketPath, { throwIfNoEntry: false })?.isSocket())
      return { status: "unmanaged" };
    const stdinTty = readlinkSync("/proc/self/fd/0");
    const inspectFormat = "#{socket_path}\t#{pid}\t#{pane_id}\t#{pane_tty}\t#{pane_pid}";
    const outcome = await run(
      tmuxCommandLine(socketPath, ["display-message", "-p", "-t", paneId, inspectFormat]),
    );
    if (outcome.status === "aborted") return { status: "aborted" };
    if (outcome.status === "failed" || outcome.status === "unavailable")
      return { status: "failed", message: errorMessage(outcome.error) };
    const failure = bashResultFailure(outcome.result);
    if (failure !== undefined) return { status: "failed", message: failure };
    const fields = resultText(outcome.result).trimEnd().split("\t");
    const [actualSocket, actualServerPid, actualPaneId, actualTty, actualPanePid] = fields;
    const isVerified =
      fields.length === 5 &&
      actualSocket === socketPath &&
      actualServerPid === tmuxServerPid &&
      actualPaneId === paneId &&
      actualTty === stdinTty &&
      Number(actualPanePid) === selfPid;
    if (!isVerified) return { status: "unmanaged" };
    return {
      status: "managed",
      binding: {
        socketPath,
        serverPid: Number(actualServerPid),
        paneId,
        serverStartTime: processStartTime(Number(actualServerPid)),
        pid: selfPid,
        started: processStartTime(selfPid),
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
  const set = await run(
    stateCommand(binding, sessionId, [state, "--title", JSON.stringify(title)]),
  );
  return executionFailure(set) ?? { status: "published" };
}

export async function unsetStateOption(
  run: BashRunner,
  binding: ManagedPaneBinding,
  sessionId: string,
): Promise<PublicationOutcome> {
  const outcome = await run(stateCommand(binding, sessionId, ["--clear"]));
  return executionFailure(outcome) ?? { status: "published" };
}

function executionFailure(outcome: BackgroundBashOutcome): PublicationOutcome | undefined {
  if (outcome.status === "aborted") return { status: "aborted" };
  if (outcome.status === "failed" || outcome.status === "unavailable")
    return { status: "failed", message: errorMessage(outcome.error) };
  if ((outcome.result.structuredContent as { exit_code?: unknown } | undefined)?.exit_code === 75)
    return { status: "busy" };
  const failure = bashResultFailure(outcome.result);
  return failure === undefined ? undefined : { status: "failed", message: failure };
}

function bashResultFailure(result: AgentToolResult<unknown>): string | undefined {
  const structured = result.structuredContent as
    | { exit_code?: unknown; truncated?: unknown }
    | undefined;
  if (result.isError || (typeof structured?.exit_code === "number" && structured.exit_code !== 0))
    return resultText(result) || "Bash reported an error";
  if (structured?.truncated || (result.details as { truncation?: unknown } | undefined)?.truncation)
    return "Bash output was truncated";
  return undefined;
}

function resultText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
