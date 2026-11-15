export type WebviewRequest =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "newSession"; cwd: string }
  | { type: "addWorkspace"; path: string }
  | { type: "unregisterWorkspace"; cwd: string }
  | { type: "openSession"; sessionId: string }
  | { type: "archiveSession"; sessionId: string }
  | { type: "unarchiveSession"; sessionId: string };

/** Live execution phase of a session, mirrored from the session state store. */
export type SessionPhase = "running" | "waiting-approval" | "waiting-user";

export interface WebviewSession {
  sessionId: string;
  displayName: string;
  updatedAtMs: number | null;
  isArchived: boolean;
  /** Live execution phase; undefined when the phase is unknown. */
  state?: SessionPhase;
  hasUnread?: boolean;
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
  | { type: "loading"; displayedSessionId?: string | null }
  | { type: "sessions"; state: WebviewState }
  | { type: "workspaceAdded" }
  | { type: "sessionsError" }
  | { type: "error"; message: string };

export function parseWebviewRequest(value: unknown): WebviewRequest | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "ready" || value.type === "refresh") return { type: value.type };
  if (value.type === "newSession" && isNonEmptyPath(value.cwd)) {
    return { type: "newSession", cwd: value.cwd };
  }
  if (value.type === "addWorkspace" && isNonEmptyPath(value.path)) {
    return { type: "addWorkspace", path: value.path };
  }
  if (value.type === "unregisterWorkspace" && isNonEmptyPath(value.cwd)) {
    return { type: "unregisterWorkspace", cwd: value.cwd };
  }
  if (
    (value.type === "openSession" ||
      value.type === "archiveSession" ||
      value.type === "unarchiveSession") &&
    isSessionId(value.sessionId)
  ) {
    return { type: value.type, sessionId: value.sessionId };
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
