export type WebviewRequest =
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "openSession"; sessionId: string }
  | { type: "archiveSession"; sessionId: string }
  | { type: "copySessionId"; sessionId: string };

export interface WebviewSession {
  sessionId: string;
  displayName: string;
  mtimeMs: number;
  isActive: boolean;
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
  if (value.type === "refresh" || value.type === "newSession") return { type: value.type };
  if (
    (value.type === "openSession" || value.type === "archiveSession" || value.type === "copySessionId") &&
    typeof value.sessionId === "string" &&
    SESSION_ID_PATTERN.test(value.sessionId)
  ) {
    return { type: value.type, sessionId: value.sessionId };
  }
  return undefined;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
