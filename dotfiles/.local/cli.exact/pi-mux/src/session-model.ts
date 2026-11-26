export type Candidate = { id: string; cwd: string };

export type ManagedSession = Candidate & { session: string; temporary: boolean };

export type Session = { id: string; cwd: string; file: string };

export type Pane = Session & {
  pane: string;
  session: string;
  name: string;
  active: boolean;
  pid: number;
  panePid: number;
  startup?: "accepted" | "ready";
  reloadReadiness?: "pending" | "drained";
  warm: boolean;
  metadata: string;
};

export type StopTarget = Pick<Pane, "pane" | "pid" | "panePid">;

export const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const STARTUP_TIMEOUT_MS = 60_000;

export const POLL_INTERVAL_MS = 50;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
