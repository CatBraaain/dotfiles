import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { subagentSessionDir } from "../agents/index.ts";

export type SessionState = "running" | "waiting-approval" | "waiting-user";

export interface SessionEntry {
  lock?: boolean;
  state?: SessionState;
  [key: string]: unknown;
}

export interface WorkspaceEntry {
  "active-sessions"?: Record<string, SessionEntry>;
  [key: string]: unknown;
}

export interface SessionStateStore {
  "active-workspaces": Record<string, WorkspaceEntry>;
  [key: string]: unknown;
}

export type StoreParseResult = { valid: true; store: SessionStateStore } | { valid: false };

export type MembershipChange =
  | { status: "written"; store: SessionStateStore }
  | { status: "skipped" };

export type ArchiveChange = MembershipChange | { status: "locked" };

export type StateChange = MembershipChange;

export type StoreWriteOutcome =
  | { status: "written" }
  | { status: "skipped" }
  | { status: "failed"; message: string };

export type ArchiveWriteOutcome = StoreWriteOutcome | { status: "locked" };

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

  let isAgentRunActive = false;

  function scheduleStateWrite(state: SessionState, ctx: ExtensionContext): void {
    if (isSubagentSession(ctx)) return;
    const storePath = sessionStateStorePath();
    const workspacePath = ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    enqueueWrite(() => setSessionStateOnDisk(storePath, workspacePath, sessionId, state))
      .then((outcome) => reportWriteFailure(ctx, storePath, outcome))
      .catch((error) => console.error(`[session-state] ${errorMessage(error)}`));
  }

  function scheduleStateClear(ctx: ExtensionContext): void {
    if (isSubagentSession(ctx)) return;
    const storePath = sessionStateStorePath();
    const workspacePath = ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    enqueueWrite(() => clearSessionStateOnDisk(storePath, workspacePath, sessionId))
      .then((outcome) => reportWriteFailure(ctx, storePath, outcome))
      .catch((error) => console.error(`[session-state] ${errorMessage(error)}`));
  }

  pi.on("input", (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    const storePath = sessionStateStorePath();
    const workspacePath = ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    enqueueWrite(() => unarchiveSessionOnDisk(storePath, workspacePath, sessionId))
      .then((outcome) => reportWriteFailure(ctx, storePath, outcome))
      .catch((error) => console.error(`[session-state] ${errorMessage(error)}`));
  });

  pi.on("session_start", (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    registerArchiveCommands();
    isAgentRunActive = false;
    scheduleStateWrite("waiting-user", ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    isAgentRunActive = true;
    scheduleStateWrite("running", ctx);
  });

  pi.on("ui_prompt_start", (_event, ctx) => {
    scheduleStateWrite("waiting-approval", ctx);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (isAgentRunActive) {
      scheduleStateWrite("running", ctx);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    isAgentRunActive = false;
    scheduleStateWrite("waiting-user", ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    scheduleStateClear(ctx);
  });

  function registerArchiveCommands(): void {
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
}

function isSubagentSession(ctx: ExtensionContext): boolean {
  return (
    resolve(ctx.sessionManager.getSessionDir()) ===
    resolve(subagentSessionDir(ctx.sessionManager.getCwd()))
  );
}

export function parseStore(raw: string): StoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false };
  }
  if (!isRecord(parsed)) return { valid: false };
  if (isRecord(parsed.workspaces)) return { valid: false };
  if (!isRecord(parsed["active-workspaces"])) return { valid: false };
  if (hasLegacySessionsList(parsed["active-workspaces"])) return { valid: false };
  return { valid: true, store: parsed as SessionStateStore };
}

export function unarchiveSession(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): MembershipChange {
  if (isSessionListed(store, workspacePath, sessionId)) {
    return { status: "skipped" };
  }
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  const activeSessions = ownActiveSessionsMap(entry);
  activeSessions[sessionId] = { lock: false };
  return { status: "written", store: nextStore };
}

export function archiveSession(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): ArchiveChange {
  const listed = sessionsEntryOf(store, workspacePath, sessionId);
  if (listed === undefined) {
    return { status: "skipped" };
  }
  if (listed.lock === true) {
    return { status: "locked" };
  }
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  const activeSessions = ownActiveSessionsMap(entry);
  delete activeSessions[sessionId];
  return { status: "written", store: nextStore };
}

export function setSessionState(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
  state: SessionState,
): StateChange {
  if (getSessionState(store, workspacePath, sessionId) === state) {
    return { status: "skipped" };
  }
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  const activeSessions = ownActiveSessionsMap(entry);
  const listed = sessionsEntryOf(nextStore, workspacePath, sessionId);
  activeSessions[sessionId] = { ...listed, state };
  return { status: "written", store: nextStore };
}

export function getSessionState(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): SessionState | undefined {
  const listed = sessionsEntryOf(store, workspacePath, sessionId);
  if (listed === undefined) return undefined;
  return isSessionState(listed.state) ? listed.state : undefined;
}

export function clearSessionState(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): StateChange {
  const { store: nextStore, entry } = storeWithOwnWorkspaceEntry(store, workspacePath);
  const activeSessions = ownActiveSessionsMap(entry);
  const current: unknown = activeSessions[sessionId];
  const hasState = isRecord(current) && "state" in current;
  if (!hasState) {
    return { status: "skipped" };
  }
  const { state: _state, ...rest } = current;
  activeSessions[sessionId] = rest;
  return { status: "written", store: nextStore };
}

export function serializeStore(store: SessionStateStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function hasLegacySessionsList(workspaces: Record<string, unknown>): boolean {
  return Object.values(workspaces).some(
    (entry) => isRecord(entry) && Array.isArray(entry["active-sessions"]),
  );
}

function isSessionListed(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): boolean {
  return sessionsEntryOf(store, workspacePath, sessionId) !== undefined;
}

function sessionsEntryOf(
  store: SessionStateStore | undefined,
  workspacePath: string,
  sessionId: string,
): SessionEntry | undefined {
  const entry = ownWorkspaceEntry(store, workspacePath);
  const activeSessions = entry?.["active-sessions"];
  if (!isRecord(activeSessions)) return undefined;
  const listed: unknown = activeSessions[sessionId];
  return isRecord(listed) ? listed : undefined;
}

function storeWithOwnWorkspaceEntry(
  store: SessionStateStore | undefined,
  workspacePath: string,
): { store: SessionStateStore; entry: WorkspaceEntry } {
  const base = clonedStore(store);
  const entry = base["active-workspaces"][workspacePath];
  if (isRecord(entry)) {
    return { store: base, entry };
  }
  const freshEntry: WorkspaceEntry = {};
  const activeWorkspaces = { ...base["active-workspaces"], [workspacePath]: freshEntry };
  return { store: { ...base, "active-workspaces": activeWorkspaces }, entry: freshEntry };
}

function ownWorkspaceEntry(
  store: SessionStateStore | undefined,
  workspacePath: string,
): WorkspaceEntry | undefined {
  const entry = store?.["active-workspaces"][workspacePath];
  return isRecord(entry) ? entry : undefined;
}

function ownActiveSessionsMap(entry: WorkspaceEntry): Record<string, SessionEntry> {
  const activeSessions = entry["active-sessions"];
  if (isRecord(activeSessions)) return activeSessions;
  const fresh: Record<string, SessionEntry> = {};
  entry["active-sessions"] = fresh;
  return fresh;
}

function clonedStore(store: SessionStateStore | undefined): SessionStateStore {
  return store === undefined ? { "active-workspaces": {} } : structuredClone(store);
}

function isSessionState(value: unknown): value is SessionState {
  return value === "running" || value === "waiting-approval" || value === "waiting-user";
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

async function setSessionStateOnDisk(
  storePath: string,
  workspacePath: string,
  sessionId: string,
  state: SessionState,
): Promise<StoreWriteOutcome> {
  try {
    const current = await loadStore(storePath);
    const planned = setSessionState(current, workspacePath, sessionId, state);
    if (planned.status === "skipped") return { status: "skipped" };
    await writeStoreAtomically(storePath, planned.store);
    return { status: "written" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

async function clearSessionStateOnDisk(
  storePath: string,
  workspacePath: string,
  sessionId: string,
): Promise<StoreWriteOutcome> {
  try {
    const current = await loadStore(storePath);
    const planned = clearSessionState(current, workspacePath, sessionId);
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

function reportWriteFailure(
  ctx: ExtensionContext,
  storePath: string,
  outcome: StoreWriteOutcome,
): void {
  if (outcome.status === "failed") {
    notify(ctx, `cannot update ${basename(storePath)}: ${outcome.message}`, "warning");
  }
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
