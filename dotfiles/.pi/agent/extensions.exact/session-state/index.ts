import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface WorkspaceEntry {
  "active-sessions"?: string[];
  "locked-sessions"?: string[];
  [key: string]: unknown;
}

export interface SessionStateStore {
  version: number;
  workspaces: Record<string, WorkspaceEntry>;
  [key: string]: unknown;
}

export type StoreParseResult = { valid: true; store: SessionStateStore } | { valid: false };

export type MembershipChange =
  | { status: "written"; store: SessionStateStore }
  | { status: "skipped" };

export type ArchiveChange = MembershipChange | { status: "locked" };

export type StoreWriteOutcome =
  | { status: "written" }
  | { status: "skipped" }
  | { status: "failed"; message: string };

export type ArchiveWriteOutcome = StoreWriteOutcome | { status: "locked" };

const STORE_VERSION = 2;

type SessionListField = "active-sessions" | "locked-sessions";

export default function sessionStateExtension(pi: ExtensionAPI): void {
  let writeQueue: Promise<void> = Promise.resolve();

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  pi.on("input", (_event, ctx) => {
    const storePath = sessionStateStorePath();
    const workspacePath = ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    enqueueWrite(() => unarchiveSessionOnDisk(storePath, workspacePath, sessionId))
      .then((outcome) => {
        if (outcome.status === "failed") {
          notify(ctx, `cannot update ${basename(storePath)}: ${outcome.message}`, "warning");
        }
      })
      .catch((error) => console.error(`[session-state] ${errorMessage(error)}`));
  });

  pi.registerCommand("archive", {
    description: "Archive this session: remove it from the workspace's active sessions.",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const storePath = sessionStateStorePath();
      const workspacePath = ctx.sessionManager.getCwd();
      const sessionId = ctx.sessionManager.getSessionId();
      const outcome = await enqueueWrite(() =>
        archiveSessionOnDisk(storePath, workspacePath, sessionId),
      );
      notifyArchiveOutcome(ctx, storePath, outcome);
    },
  });

  pi.registerCommand("unarchive", {
    description: "Unarchive this session: add it back to the workspace's active sessions.",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const storePath = sessionStateStorePath();
      const workspacePath = ctx.sessionManager.getCwd();
      const sessionId = ctx.sessionManager.getSessionId();
      const outcome = await enqueueWrite(() =>
        unarchiveSessionOnDisk(storePath, workspacePath, sessionId),
      );
      notifyUnarchiveOutcome(ctx, storePath, outcome);
    },
  });
}

export function parseStore(raw: string): StoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false };
  }
  if (!isRecord(parsed)) return { valid: false };
  if (parsed.version !== STORE_VERSION) return { valid: false };
  if (!isRecord(parsed.workspaces)) return { valid: false };
  return { valid: true, store: parsed as SessionStateStore };
}

export function unarchiveSession(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): MembershipChange {
  if (isSessionListed(store, workspacePath, sessionId, "active-sessions")) {
    return { status: "skipped" };
  }
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  entry["active-sessions"] = [...sessionList(entry, "active-sessions"), sessionId];
  return { status: "written", store: nextStore };
}

export function archiveSession(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): ArchiveChange {
  if (isSessionListed(store, workspacePath, sessionId, "locked-sessions")) {
    return { status: "locked" };
  }
  if (!isSessionListed(store, workspacePath, sessionId, "active-sessions")) {
    return { status: "skipped" };
  }
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  entry["active-sessions"] = sessionList(entry, "active-sessions").filter(
    (listedId) => listedId !== sessionId,
  );
  return { status: "written", store: nextStore };
}

export function serializeStore(store: SessionStateStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function isSessionListed(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
  field: SessionListField,
): boolean {
  const entry = ownWorkspaceEntry(store, workspacePath);
  return entry !== undefined && sessionList(entry, field).includes(sessionId);
}

function storeWithOwnWorkspaceEntry(
  store: SessionStateStore | undefined,
  workspacePath: string,
): { store: SessionStateStore; entry: WorkspaceEntry } {
  const base: SessionStateStore =
    store === undefined ? { version: STORE_VERSION, workspaces: {} } : structuredClone(store);
  const entry = base.workspaces[workspacePath];
  if (isRecord(entry)) {
    return { store: base, entry };
  }
  const freshEntry: WorkspaceEntry = {};
  const workspaces = { ...base.workspaces, [workspacePath]: freshEntry };
  return { store: { ...base, workspaces }, entry: freshEntry };
}

function ownWorkspaceEntry(
  store: SessionStateStore | undefined,
  workspacePath: string,
): WorkspaceEntry | undefined {
  const entry = store?.workspaces[workspacePath];
  return isRecord(entry) ? entry : undefined;
}

function sessionList(entry: WorkspaceEntry, field: SessionListField): string[] {
  const sessions: unknown = entry[field];
  return Array.isArray(sessions) ? sessions : [];
}

function sessionStateStorePath(): string {
  return join(getAgentDir(), "session-state.json");
}

async function unarchiveSessionOnDisk(
  storePath: string,
  workspacePath: string,
  sessionId: string,
): Promise<StoreWriteOutcome> {
  try {
    const current = await loadStore(storePath);
    const planned = unarchiveSession(current, workspacePath, sessionId);
    if (planned.status === "skipped") return { status: "skipped" };
    await writeStoreAtomically(storePath, planned.store);
    return { status: "written" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

async function archiveSessionOnDisk(
  storePath: string,
  workspacePath: string,
  sessionId: string,
): Promise<ArchiveWriteOutcome> {
  try {
    const current = await loadStore(storePath);
    const planned = archiveSession(current, workspacePath, sessionId);
    if (planned.status === "locked") return { status: "locked" };
    if (planned.status === "skipped") return { status: "skipped" };
    await writeStoreAtomically(storePath, planned.store);
    return { status: "written" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

function notifyArchiveOutcome(
  ctx: ExtensionContext,
  storePath: string,
  outcome: ArchiveWriteOutcome,
): void {
  if (outcome.status === "written") {
    notify(ctx, "archived this session", "info");
    return;
  }
  if (outcome.status === "skipped") {
    notify(ctx, "already archived", "info");
    return;
  }
  if (outcome.status === "locked") {
    notify(ctx, "this session is locked; left active", "warning");
    return;
  }
  notify(ctx, `cannot update ${basename(storePath)}: ${outcome.message}`, "warning");
}

function notifyUnarchiveOutcome(
  ctx: ExtensionContext,
  storePath: string,
  outcome: StoreWriteOutcome,
): void {
  if (outcome.status === "written") {
    notify(ctx, "unarchived this session", "info");
    return;
  }
  if (outcome.status === "skipped") {
    notify(ctx, "already active", "info");
    return;
  }
  notify(ctx, `cannot update ${basename(storePath)}: ${outcome.message}`, "warning");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  if (ctx.hasUI) ctx.ui.notify(`session-state: ${message}`, level);
  else console.error(`[session-state] ${message}`);
}

async function loadStore(storePath: string): Promise<SessionStateStore | undefined> {
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
  const parsed = parseStore(raw);
  if (!parsed.valid) {
    throw new Error(`${basename(storePath)} is not a valid session-state store`);
  }
  return parsed.store;
}

async function writeStoreAtomically(storePath: string, store: SessionStateStore): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const tmpPath = join(dirname(storePath), `.${basename(storePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, serializeStore(store), "utf8");
    await rename(tmpPath, storePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
