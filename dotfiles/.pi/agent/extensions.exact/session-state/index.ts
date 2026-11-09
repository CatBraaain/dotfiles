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
import { requestBackgroundBash, type BackgroundBashContext } from "../tools/background-bash.ts";
import {
  detectManagedPane,
  publishPhase,
  unsetPhaseOption,
  type BashRunner,
  type ManagedPaneBinding,
  type PublicationOutcome,
  type SessionPhase,
} from "./tmux.ts";

const TMUX_COMMAND_TIMEOUT_S = 1;
const MAX_NOTIFICATION_LENGTH = 200;
const PUBLICATION_STOPPED = Symbol.for("pi.session-state.publication-stopped");
const publicationProcess = process as NodeJS.Process & { [PUBLICATION_STOPPED]?: boolean };

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

export type StoreWriteOutcome =
  | { status: "written" }
  | { status: "skipped" }
  | { status: "failed"; message: string };

export type ArchiveWriteOutcome = StoreWriteOutcome | { status: "locked" };

interface PublicationGeneration {
  controller: AbortController;
  binding?: ManagedPaneBinding;
  phase?: SessionPhase;
  sessionId: string;
  run: BashRunner;
  notify: (message: string) => void;
}

export default function sessionStateExtension(pi: ExtensionAPI): void {
  let writeQueue: Promise<void> = Promise.resolve();
  let publicationQueue: Promise<void> = Promise.resolve();
  let generation: PublicationGeneration | undefined;
  let isAgentRunActive = false;
  let isWaitingForApproval = false;

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function enqueuePublication(gen: PublicationGeneration, task: () => Promise<void>): void {
    publicationQueue = publicationQueue
      .then(() => {
        if (!publicationProcess[PUBLICATION_STOPPED]) return task();
      })
      .catch((error) => {
        if (!gen.controller.signal.aborted) gen.notify(errorMessage(error));
      });
  }

  function makeBashRunner(
    context: BackgroundBashContext,
    notify: (message: string) => void,
  ): BashRunner {
    return async function run(command) {
      const outcome = await requestBackgroundBash(pi.events, {
        id: "session-state-tmux",
        params: { command, timeout: TMUX_COMMAND_TIMEOUT_S },
        context,
      });
      if (outcome.status !== "completed") {
        publicationProcess[PUBLICATION_STOPPED] = true;
        const reason = outcome.status === "aborted" ? outcome.reason : outcome.error;
        (generation?.notify ?? notify)(
          `session phase publication stopped: Bash completion is unknown (${outcome.status}): ${errorMessage(reason)}`,
        );
      }
      return outcome;
    };
  }

  function schedulePhasePublication(phase: SessionPhase): void {
    const gen = generation;
    if (!gen || gen.phase === phase) return;
    gen.phase = phase;
    enqueuePublication(gen, async () => {
      if (gen.controller.signal.aborted || !gen.binding) return;
      const outcome = await publishPhase(gen.run, gen.binding, gen.sessionId, phase);
      if (!publicationProcess[PUBLICATION_STOPPED] && !gen.controller.signal.aborted)
        reportPublicationOutcome(gen, outcome);
    });
  }

  pi.on("input", (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    const storePath = sessionStateStorePath();
    const workspacePath = ctx.sessionManager.getCwd();
    const sessionId = ctx.sessionManager.getSessionId();
    const notify = makeNotifier(ctx);
    enqueueWrite(() => unarchiveSessionOnDisk(storePath, workspacePath, sessionId))
      .then((outcome) => {
        if (outcome.status === "failed")
          notify(`cannot update ${basename(storePath)}: ${outcome.message}`);
      })
      .catch((error) => notify(errorMessage(error)));
  });

  pi.on("session_start", (_event, ctx) => {
    generation?.controller.abort();
    generation = undefined;
    isAgentRunActive = false;
    isWaitingForApproval = false;
    if (isSubagentSession(ctx)) return;
    registerArchiveCommands();
    const context = captureBashContext(ctx);
    const controller = new AbortController();
    const environment = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
    };
    const notify = makeNotifier(ctx);
    const gen: PublicationGeneration = {
      controller,
      sessionId: ctx.sessionManager.getSessionId(),
      run: makeBashRunner(context, notify),
      notify,
    };
    generation = gen;
    enqueuePublication(gen, async () => {
      if (gen.controller.signal.aborted) return;
      const detection = await detectManagedPane(gen.run, environment);
      if (publicationProcess[PUBLICATION_STOPPED] || gen.controller.signal.aborted) return;
      if (detection.status === "managed") gen.binding = detection.binding;
      if (detection.status === "failed")
        gen.notify(`cannot confirm managed tmux pane: ${detection.message}`);
      if (detection.status === "aborted") gen.notify("managed tmux pane check was interrupted");
    });
    schedulePhasePublication("waiting-user");
  });

  pi.on("agent_start", () => {
    isAgentRunActive = true;
    if (!isWaitingForApproval) schedulePhasePublication("running");
  });
  pi.on("ui_prompt_start", () => {
    isWaitingForApproval = true;
    schedulePhasePublication("waiting-approval");
  });
  pi.on("ui_prompt_end", () => {
    isWaitingForApproval = false;
    schedulePhasePublication(isAgentRunActive ? "running" : "waiting-user");
  });
  pi.on("agent_settled", () => {
    isAgentRunActive = false;
    if (!isWaitingForApproval) schedulePhasePublication("waiting-user");
  });
  pi.on("session_shutdown", async () => {
    const gen = generation;
    generation = undefined;
    isAgentRunActive = false;
    isWaitingForApproval = false;
    gen?.controller.abort();
    if (gen) {
      enqueuePublication(gen, async () => {
        if (!gen.binding) return;
        try {
          const outcome = await unsetPhaseOption(gen.run, gen.binding);
          if (publicationProcess[PUBLICATION_STOPPED]) return;
          if (outcome.status === "failed")
            gen.notify(`cannot clear session phase option: ${outcome.message}`);
          if (outcome.status === "aborted") gen.notify("session phase cleanup was interrupted");
        } catch (error) {
          gen.notify(`cannot clear session phase option: ${errorMessage(error)}`);
        }
      });
    }
    await Promise.all([publicationQueue, writeQueue]);
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

function captureBashContext(ctx: ExtensionContext): BackgroundBashContext {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  };
}

function reportPublicationOutcome(gen: PublicationGeneration, outcome: PublicationOutcome): void {
  if (outcome.status === "failed") gen.notify(`cannot publish session phase: ${outcome.message}`);
  if (outcome.status === "aborted") gen.notify("session phase publication was interrupted");
}

function makeNotifier(ctx: ExtensionContext): (message: string) => void {
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const notify = ui?.notify.bind(ui);
  return function report(message) {
    const summary = message.replace(/\s+/g, " ").slice(0, MAX_NOTIFICATION_LENGTH);
    if (notify) notify(`session-state: ${summary}`, "warning");
    else console.error(`[session-state] ${summary}`);
  };
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
