export type WebviewRequest =
  | { type: "ready"; requestId?: string }
  | { type: "refresh" }
  | { type: "newSession"; cwd: string; requestId?: string }
  | { type: "addWorkspace"; path: string }
  | { type: "openWorkspaceTerminal" | "unregisterWorkspace"; cwd: string }
  | { type: "openSession" | "reloadSession" | "copySessionId"; sessionId: string }
  | { type: "archiveSession"; sessionId: string; requestId?: string }
  | { type: "unarchiveSession"; sessionId: string; requestId?: string };

/** Live execution phase of a session, mirrored from the session state store. */
export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

export interface WebviewSession {
  sessionId: string;
  displayName: string;
  updatedAtMs: number | null;
  isArchived: boolean;
  isLive?: boolean;
  /** Live execution phase; undefined when the phase is unknown. */
  state?: SessionPhase;
  hasUnread?: boolean;
  /** True while a state publication is known to be incomplete for the session. */
  publishDelayed?: boolean;
}

export interface WebviewSessionGroup {
  cwd: string;
  label: string;
  sessions: WebviewSession[];
}

export interface WebviewState {
  groups: WebviewSessionGroup[];
  /** Session the shared display terminal currently shows; undefined when it shows none. */
  displayedSessionId?: string;
}

export type ExtensionMessage =
  | { type: "loading"; displayedSessionId?: string | null; manual: boolean; requestId?: string }
  | { type: "sessions"; state: WebviewState; requestId?: string }
  | { type: "workspaceAdded" }
  | { type: "newSessionFinished"; requestId: string }
  | { type: "archiveFinished"; requestId: string }
  | { type: "unarchiveFinished"; requestId: string }
  | { type: "sessionsError"; requestId?: string }
  | { type: "error"; message: string };

export function parseWebviewRequest(value: unknown): WebviewRequest | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "refresh") return { type: value.type };
  if (value.type === "ready") {
    if (value.requestId !== undefined && !isNonEmptyPath(value.requestId)) return undefined;
    return {
      type: "ready",
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    };
  }
  if (value.type === "newSession" && isNonEmptyPath(value.cwd)) {
    if (value.requestId !== undefined && !isNonEmptyPath(value.requestId)) return undefined;
    return {
      type: "newSession",
      cwd: value.cwd,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    };
  }
  if (value.type === "addWorkspace" && isNonEmptyPath(value.path)) {
    return { type: "addWorkspace", path: value.path };
  }
  if (
    (value.type === "openWorkspaceTerminal" || value.type === "unregisterWorkspace") &&
    isNonEmptyPath(value.cwd)
  ) {
    return { type: value.type, cwd: value.cwd };
  }
  if (!isSessionId(value.sessionId)) return undefined;
  if (
    value.type === "openSession" ||
    value.type === "reloadSession" ||
    value.type === "copySessionId"
  ) {
    return { type: value.type, sessionId: value.sessionId };
  }
  if (value.type === "archiveSession" || value.type === "unarchiveSession") {
    if (value.requestId !== undefined && !isNonEmptyPath(value.requestId)) return undefined;
    return {
      type: value.type,
      sessionId: value.sessionId,
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    };
  }
  return undefined;
}

// Pi session id shape per pi's assertValidSessionId (UUID by default, custom ids allowed)
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Path arguments must arrive trimmed and non-empty; the webview trims input values. */
function isNonEmptyPath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
