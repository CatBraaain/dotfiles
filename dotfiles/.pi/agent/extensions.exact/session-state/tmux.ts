import { readlinkSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { quote } from "shell-quote";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackgroundBashOutcome } from "../tools/background-bash.ts";

export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

export const PANE_OPTION_NAME = "@pi_session_state";
export const OPTION_VALUE_VERSION = 1;

export interface ManagedPaneBinding {
  socketPath: string;
  serverPid: number;
  paneId: string;
}

export type BashRunner = (command: string) => Promise<BackgroundBashOutcome>;

export type ManagedPaneDetection =
  | { status: "managed"; binding: ManagedPaneBinding }
  | { status: "unmanaged" }
  | { status: "aborted" }
  | { status: "failed"; message: string };

export type PublicationOutcome =
  | { status: "published" }
  | { status: "aborted" }
  | { status: "failed"; message: string };

export function dedicatedSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  if (!isAbsolute(runtimeDir)) throw new Error("XDG_RUNTIME_DIR must be absolute");
  return join(runtimeDir, "pi-tmux", "server.sock");
}

export function phaseOptionValue(sessionId: string, phase: SessionPhase): string {
  return JSON.stringify({ version: OPTION_VALUE_VERSION, sessionId, phase });
}

export function tmuxCommandLine(socketPath: string, args: string[]): string {
  if (!isAbsolute(socketPath)) throw new Error("tmux socket path must be absolute");
  return quote(["tmux", "-S", socketPath, ...args]);
}

export function setPhaseOptionCommand(socketPath: string, paneId: string, value: string): string {
  return tmuxCommandLine(socketPath, ["set-option", "-p", "-t", paneId, PANE_OPTION_NAME, value]);
}

export function unsetPhaseOptionCommand(socketPath: string, paneId: string): string {
  return tmuxCommandLine(socketPath, ["set-option", "-p", "-u", "-t", paneId, PANE_OPTION_NAME]);
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
      binding: { socketPath, serverPid: Number(actualServerPid), paneId },
    };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

export async function publishPhase(
  run: BashRunner,
  binding: ManagedPaneBinding,
  sessionId: string,
  phase: SessionPhase,
): Promise<PublicationOutcome> {
  const value = phaseOptionValue(sessionId, phase);
  const set = await run(setPhaseOptionCommand(binding.socketPath, binding.paneId, value));
  return executionFailure(set) ?? { status: "published" };
}

export async function unsetPhaseOption(
  run: BashRunner,
  binding: ManagedPaneBinding,
): Promise<PublicationOutcome> {
  const outcome = await run(unsetPhaseOptionCommand(binding.socketPath, binding.paneId));
  return executionFailure(outcome) ?? { status: "published" };
}

function executionFailure(outcome: BackgroundBashOutcome): PublicationOutcome | undefined {
  if (outcome.status === "aborted") return { status: "aborted" };
  if (outcome.status === "failed" || outcome.status === "unavailable")
    return { status: "failed", message: errorMessage(outcome.error) };
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
