import { isAbsolute } from "node:path";
import { isRecord, UUID } from "./session-model";

export type StateSource = {
  socket: string;
  serverPid: number;
  pane: string;
  pid: number;
  token: string;
};

export type StateNotification =
  | { clear: true }
  | { clear: false; state: SessionState; title: string | null };

export type SessionState = "running" | "waiting-approval" | "waiting-user";

export type PublishPending = { attemptAt: number };

export function parseSource(source: unknown): StateSource {
  if (
    !isRecord(source) ||
    typeof source.socket !== "string" ||
    !isAbsolute(source.socket) ||
    !Number.isSafeInteger(source.serverPid) ||
    Number(source.serverPid) <= 0 ||
    typeof source.pane !== "string" ||
    !/^%\d+$/.test(source.pane) ||
    !Number.isSafeInteger(source.pid) ||
    Number(source.pid) <= 0 ||
    typeof source.token !== "string" ||
    !UUID.test(source.token)
  )
    throw new Error("Invalid source");
  return {
    socket: source.socket,
    serverPid: Number(source.serverPid),
    pane: source.pane,
    pid: Number(source.pid),
    token: source.token,
  };
}

export function clearStateOptions(pane: string): string[][] {
  return [
    "@pi_session_state",
    "@pi-mux-state-source",
    "@pi-mux-pending-restart-blocker",
    "@pi_session_state_pending",
  ].map((option) => ["set-option", "-pu", "-t", pane, option]);
}

export function parseSessionState(encoded: string | undefined, id: string): SessionState | null {
  const state = parseSessionOption(encoded, id)?.state;
  return isSessionState(state) ? state : null;
}

export function isSessionState(state: unknown): state is SessionState {
  return state === "running" || state === "waiting-approval" || state === "waiting-user";
}

export function parsePublishPending(
  encoded: string | undefined,
  id: string,
): PublishPending | null {
  if (!encoded) return null;
  let pending: { version?: unknown; sessionId?: unknown; attemptAt?: unknown } | null;
  try {
    pending = JSON.parse(encoded);
  } catch {
    return null;
  }
  const attemptAt = isRecord(pending) ? pending.attemptAt : undefined;
  if (
    pending?.version !== 1 ||
    pending.sessionId !== id ||
    typeof attemptAt !== "number" ||
    !Number.isSafeInteger(attemptAt) ||
    attemptAt <= 0
  )
    return null;
  return { attemptAt };
}

export function parseSessionOption(
  encoded: string | undefined,
  id: string,
): Record<string, unknown> | undefined {
  if (!encoded) return undefined;
  let metadata: unknown;
  try {
    metadata = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(metadata) || metadata.version !== 1 || metadata.sessionId !== id) return undefined;
  return metadata;
}
