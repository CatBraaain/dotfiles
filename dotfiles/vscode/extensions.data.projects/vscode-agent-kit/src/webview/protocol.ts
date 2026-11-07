export type WebviewRequest =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "newSession"; cwd: string }
  | { type: "addWorkspace"; path: string }
  | { type: "unregisterWorkspace"; cwd: string }
  | { type: "openSession"; sessionId: string }
  | { type: "archiveSession"; sessionId: string }
  | { type: "unarchiveSession"; sessionId: string }
  | { type: "setSessionLock"; sessionId: string; locked: boolean }
  | { type: "copySessionId"; sessionId: string };

export interface WebviewSession {
  sessionId: string;
  displayName: string;
  mtimeMs: number;
  isArchived: boolean;
  isLocked: boolean;
}

export interface WebviewSessionGroup {
  cwd: string;
  label: string;
  /** True when the cwd comes from a registered workspace (New Workspace). */
  registered: boolean;
  /** Workspace entry's view toggle: false hides the group in the default view. */
  workspaceActive: boolean;
  sessions: WebviewSession[];
}

export interface WebviewState {
  groups: WebviewSessionGroup[];
  /** Session the shared display terminal currently shows; undefined when it shows none. */
  displayedSessionId?: string;
}

export type ExtensionMessage =
  | { type: "sessions"; state: WebviewState }
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
      value.type === "copySessionId" ||
      value.type === "archiveSession" ||
      value.type === "unarchiveSession" ||
      value.type === "setSessionLock") &&
    isSessionId(value.sessionId)
  ) {
    if (value.type === "setSessionLock") {
      return typeof value.locked === "boolean"
        ? { type: "setSessionLock", sessionId: value.sessionId, locked: value.locked }
        : undefined;
    }
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
