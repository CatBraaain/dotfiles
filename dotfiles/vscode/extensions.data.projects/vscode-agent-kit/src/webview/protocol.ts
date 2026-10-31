export type WebviewRequest =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "openSession"; sessionId: string }
  | { type: "archiveSessions"; sessionIds: string[] }
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
  sessions: WebviewSession[];
}

export interface WebviewState {
  groups: WebviewSessionGroup[];
}

export type ExtensionMessage =
  | { type: "sessions"; state: WebviewState }
  | { type: "error"; message: string };

export function parseWebviewRequest(value: unknown): WebviewRequest | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "ready" || value.type === "refresh" || value.type === "newSession")
    return { type: value.type };
  if (
    (value.type === "openSession" ||
      value.type === "copySessionId" ||
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
  if (
    value.type === "archiveSessions" &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.length > 0 &&
    value.sessionIds.every(isSessionId)
  ) {
    return { type: "archiveSessions", sessionIds: value.sessionIds };
  }
  return undefined;
}

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
