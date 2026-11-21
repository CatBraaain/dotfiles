import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkspaceStore } from "../workspaceStore";
import { listSessionSnapshot, sessionFileExists, type SessionSummary } from "../sessionStore";
import { expandWorkDirectoryInput, requireWorkDirectory } from "../workDirectory";
import { DisplayRecoveryCancelledError, type TerminalRegistry } from "../terminalRegistry";
import type { EmptySessionPool } from "../emptySessionPool";
import { errorMessage } from "../guards";
import { cwdGroupKey } from "../grouping";
import { flattenPiMuxSessions, type PiMuxHistoryEntry, type PiMuxWorkspace } from "../piMux";
import {
  parseWebviewRequest,
  type ExtensionMessage,
  type SessionPhase,
  type WebviewState,
} from "./protocol";
import { sessionViewGroups } from "./sessionViewData";
import { webviewHtml } from "./webviewHtml";

export const VIEW_ID = "agentKit.sessions";
export const LIST_REFRESH_INTERVAL_MS = 250;
const INITIAL_HISTORY_RETRY_MS = 1_000;
const MAX_HISTORY_RETRY_MS = 30_000;

export interface SessionWebviewDeps {
  extensionUri: string;
  registry: TerminalRegistry;
  workspaceStore: Pick<WorkspaceStore, "list" | "add" | "remove">;
  startNewSession: (cwd: string, onPresented: () => void) => Promise<string | undefined>;
  onWorkspaces?: (cwds: readonly string[]) => void;
  onSessionFiles?: (files: readonly { file: string; cwd: string }[]) => void;
  emptySessions?: EmptySessionPool;
  log?: Pick<vscode.LogOutputChannel, "error">;
}

/** Owns the WebviewView and translates its fixed message protocol into extension actions. */
export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private registeredCwds = new Set<string>();
  private addedCwds = new Set<string>();
  private workspaceUpdates: Promise<void> = Promise.resolve();
  private sessionsById = new Map<string, SessionSummary>();
  private archivedSessionIds = new Set<string>();
  private temporarySessionIds = new Set<string>();
  private state: WebviewState | undefined;
  private postedStateJson: string | undefined;
  private publishedSessions:
    | {
        workspaces: PiMuxWorkspace[];
        history: PiMuxHistoryEntry[];
        addedCwds: ReadonlySet<string>;
        unreadIds: ReadonlySet<string>;
        state: WebviewState;
      }
    | undefined;
  private runningSessionIds = new Set<string>();
  private runningObservations = new Map<string, symbol>();
  private unreadSessionIds = new Set<string>();
  private refreshVersion = 0;
  private latestSelection: symbol | undefined;
  private readonly pendingOpens = new Map<AbortController, string>();
  private pendingRefresh: Promise<void> | undefined;
  private refreshRequested = false;
  private manualLoadingRequested = false;
  private disposed = false;
  private listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingList: Promise<PiMuxWorkspace[]> | undefined;
  private pendingHistoryRefresh: Promise<void> | undefined;
  private latestWorkspaces: PiMuxWorkspace[] = [];
  private listFailed = false;
  private historySnapshot: PiMuxHistoryEntry[] | undefined;
  private historyRequested = true;
  private historyFailed = false;
  private historyGeneration = 0;
  private historyRetryMs = INITIAL_HISTORY_RETRY_MS;
  private historyRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private latestListMessage:
    | Extract<ExtensionMessage, { type: "loading" | "sessions" | "sessionsError" }>
    | undefined;

  constructor(private readonly deps: SessionWebviewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.stopListPolling();
    this.postedStateJson = undefined;
    this.view = webviewView;
    const extensionUri = vscode.Uri.file(this.deps.extensionUri);
    const clientRoot = vscode.Uri.joinPath(extensionUri, "dist-webview");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [clientRoot],
    };
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(clientRoot, "webview", "client.js"),
    );
    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.view = undefined;
      this.refreshVersion += 1;
      this.scheduleListRefresh();
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView) return;
      this.refreshVersion += 1;
      if (webviewView.visible) void this.refresh(false);
    });
    webviewView.webview.html = webviewHtml({
      scriptUri: scriptUri.toString(),
      nonce: randomBytes(16).toString("base64"),
    });
    void this.refresh(false);
  }

  dispose(): void {
    this.disposed = true;
    this.stopListPolling();
    clearTimeout(this.historyRetryTimer);
    this.view = undefined;
    this.runningSessionIds.clear();
    this.runningObservations.clear();
    this.unreadSessionIds.clear();
    this.refreshVersion += 1;
  }

  async refresh(refreshHistory = true): Promise<void> {
    if (refreshHistory) this.invalidateAllHistory();
    return this.requestRefresh(false);
  }

  async refreshManually(): Promise<void> {
    this.invalidateAllHistory();
    return this.requestRefresh(true);
  }

  private invalidateAllHistory(): void {
    clearTimeout(this.historyRetryTimer);
    this.historyRetryTimer = undefined;
    this.historyGeneration += 1;
    this.historyRequested = true;
  }

  async onSessionFileChanged(): Promise<void> {
    if (this.disposed) return;
    this.historyRequested = true;
    if (!this.view?.visible) return;
    if (this.listFailed || this.historySnapshot === undefined) {
      void this.refresh(false);
      return;
    }
    this.post({
      type: "loading",
      manual: false,
      displayedSessionId: this.deps.registry.displayedSessionId ?? null,
    });
    void this.refreshHistory();
  }

  private async requestRefresh(manual: boolean): Promise<void> {
    if (this.disposed) return;
    this.refreshVersion += 1;
    this.refreshRequested = true;
    this.manualLoadingRequested ||= manual;
    if (this.pendingRefresh !== undefined) return this.pendingRefresh;
    const pending = this.drainRefreshes();
    this.pendingRefresh = pending;
    try {
      await pending;
    } finally {
      this.pendingRefresh = undefined;
    }
  }

  private async drainRefreshes(): Promise<void> {
    while (this.refreshRequested && !this.disposed) {
      this.refreshRequested = false;
      const manual = this.manualLoadingRequested;
      this.manualLoadingRequested = false;
      await this.refreshSessions(manual);
    }
  }

  private stopListPolling(): void {
    clearTimeout(this.listRefreshTimer);
    this.listRefreshTimer = undefined;
  }

  private scheduleListRefresh(): void {
    if (this.disposed || this.pendingList !== undefined) return;
    this.stopListPolling();
    this.listRefreshTimer = setTimeout(() => void this.pollList(), LIST_REFRESH_INTERVAL_MS);
    this.listRefreshTimer.unref();
  }

  private async readWorkspaces(): Promise<PiMuxWorkspace[]> {
    if (this.pendingList !== undefined) {
      await this.pendingList.catch(() => undefined);
      return this.readWorkspaces();
    }
    this.stopListPolling();
    const pending = this.deps.registry.mux.list();
    this.pendingList = pending;
    try {
      return await pending;
    } finally {
      this.pendingList = undefined;
      this.scheduleListRefresh();
    }
  }

  private updateAddedWorkspaces(
    cwds: readonly string[],
    version: number,
    removedCwd?: string,
  ): Promise<void> {
    const pending = this.workspaceUpdates.then(async () => {
      const added = await this.deps.workspaceStore.list();
      if (this.disposed || (removedCwd === undefined && version !== this.refreshVersion)) return;
      for (const cwd of cwds) {
        if (added.has(cwd)) continue;
        await this.deps.workspaceStore.add(cwd);
        added.add(cwd);
      }
      if (removedCwd !== undefined) {
        await this.deps.workspaceStore.remove(removedCwd);
        added.delete(removedCwd);
      }
      this.addedCwds = added;
    });
    this.workspaceUpdates = pending.catch(() => undefined);
    return pending.catch((error) => {
      throw new Error(`Failed to save Session List workspaces: ${errorMessage(error)}`);
    });
  }

  private async acceptWorkspaces(workspaces: PiMuxWorkspace[], version: number): Promise<boolean> {
    await this.updateAddedWorkspaces(
      workspaces.map(({ cwd }) => cwd),
      version,
    );
    if (this.disposed || version !== this.refreshVersion) return false;
    this.listFailed = false;
    const previousWorkspaces = this.latestWorkspaces;
    const registered = new Set(workspaces.map(({ cwd }) => cwd));
    const removed = [...this.registeredCwds].some((cwd) => !registered.has(cwd));
    const added = [...registered].some((cwd) => !this.registeredCwds.has(cwd));
    if (removed) {
      this.historyGeneration += 1;
      this.historySnapshot = this.historySnapshot?.filter(({ cwd }) => registered.has(cwd));
      if (this.pendingHistoryRefresh !== undefined) this.historyRequested = true;
    }
    const previousFiles = new Set(
      previousWorkspaces.flatMap(({ sessions }) => sessions.map(({ file }) => file)),
    );
    const newlySaved = workspaces.some(({ sessions }) =>
      sessions.some(
        ({ file }) =>
          !previousFiles.has(file) && !this.historySnapshot?.some((entry) => entry.file === file),
      ),
    );
    this.historyRequested ||= added || newlySaved;
    this.latestWorkspaces = workspaces;
    this.registeredCwds = registered;
    if (registered.size === 0) {
      this.historySnapshot = [];
      this.historyRequested = false;
      this.historyFailed = false;
      clearTimeout(this.historyRetryTimer);
      this.historyRetryTimer = undefined;
      this.historyRetryMs = INITIAL_HISTORY_RETRY_MS;
    }
    this.publishSessionFiles();
    this.deps.onWorkspaces?.([...this.registeredCwds]);
    const live = flattenPiMuxSessions(workspaces);
    this.temporarySessionIds = new Set(
      live.filter(({ temporary }) => temporary).map(({ id }) => id),
    );
    if (!this.historyFailed) {
      this.updateUnread(
        live.map(({ id }) => ({ sessionId: id })),
        {
          archivedIds: this.temporarySessionIds,
          livePhases: phasesFromWorkspaces(workspaces),
        },
      );
    }
    return true;
  }

  private async pollList(): Promise<void> {
    const version = this.refreshVersion;
    try {
      const workspaces = await this.readWorkspaces();
      if (this.disposed || version !== this.refreshVersion) return;
      if (!(await this.acceptWorkspaces(workspaces, version))) return;
      if (this.view?.visible) {
        if (this.pendingHistoryRefresh !== undefined) await this.publishSessions();
        else void this.refreshHistory();
      }
    } catch (error) {
      if (version !== this.refreshVersion) return;
      this.listFailed = true;
      this.reportAcquisitionError(error);
    }
  }

  private async refreshHistory(): Promise<void> {
    if (this.pendingHistoryRefresh !== undefined) return this.pendingHistoryRefresh;
    if (!this.historyRequested || this.historyRetryTimer !== undefined) {
      if (this.historyFailed) this.post({ type: "sessionsError" });
      else await this.publishSessions();
      return;
    }
    const pending = this.loadHistory();
    this.pendingHistoryRefresh = pending;
    try {
      await pending;
    } catch (error) {
      this.reportAcquisitionError(error);
    } finally {
      this.pendingHistoryRefresh = undefined;
    }
  }

  private async loadHistory(): Promise<void> {
    while (
      this.historyRequested &&
      !this.disposed &&
      this.view?.visible &&
      this.registeredCwds.size > 0 &&
      this.historyRetryTimer === undefined
    ) {
      const generation = this.historyGeneration;
      this.historyRequested = false;
      try {
        const entries = await this.deps.registry.mux.history();
        if (this.disposed) return;
        if (generation !== this.historyGeneration) continue;
        this.historySnapshot = entries;
        this.historyFailed = false;
        this.historyRetryMs = INITIAL_HISTORY_RETRY_MS;
      } catch (error) {
        if (this.disposed) return;
        if (generation !== this.historyGeneration) continue;
        this.historyFailed = true;
        this.historyRequested = true;
        this.historyRetryTimer = setTimeout(() => {
          this.historyRetryTimer = undefined;
          if (this.view?.visible) void this.refresh(false);
        }, this.historyRetryMs);
        this.historyRetryTimer.unref();
        this.historyRetryMs = Math.min(this.historyRetryMs * 2, MAX_HISTORY_RETRY_MS);
        this.reportAcquisitionError(error);
        return;
      }
      this.publishSessionFiles();
      await this.publishSessions();
    }
  }

  private publishSessionFiles(): void {
    this.deps.onSessionFiles?.([
      ...(this.historySnapshot ?? [])
        .filter(({ cwd }) => this.registeredCwds.has(cwd))
        .map(({ file, cwd }) => ({ file, cwd })),
      ...this.latestWorkspaces.flatMap(({ cwd, sessions, empty }) =>
        [...sessions, ...empty].map(({ file }) => ({ file, cwd })),
      ),
    ]);
  }

  private async publishSessions(): Promise<void> {
    if (
      this.disposed ||
      !this.view?.visible ||
      this.listFailed ||
      this.historyFailed ||
      this.historySnapshot === undefined
    )
      return;
    const workspaces = this.latestWorkspaces;
    const history = this.historySnapshot;
    const published = this.publishedSessions;
    if (
      published !== undefined &&
      this.postedStateJson !== undefined &&
      this.state === published.state &&
      history === published.history &&
      this.deps.registry.displayedSessionId === published.state.displayedSessionId &&
      isDeepStrictEqual(workspaces, published.workspaces) &&
      isDeepStrictEqual(this.addedCwds, published.addedCwds) &&
      isDeepStrictEqual(this.unreadSessionIds, published.unreadIds)
    )
      return;
    const version = this.refreshVersion;
    const addedCwds = this.addedCwds;
    const { sessions, archivedIds } = await listSessionSnapshot(history, workspaces);
    if (
      this.disposed ||
      !this.view?.visible ||
      version !== this.refreshVersion ||
      workspaces !== this.latestWorkspaces ||
      history !== this.historySnapshot ||
      addedCwds !== this.addedCwds
    )
      return;
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    this.archivedSessionIds = archivedIds;
    const state: WebviewState = {
      groups: sessionViewGroups(sessions, {
        registeredCwds: [...addedCwds],
        archivedIds,
        phases: phasesFromWorkspaces(workspaces),
        unreadIds: this.unreadSessionIds,
      }),
      displayedSessionId: this.deps.registry.displayedSessionId,
    };
    this.postState(state);
    this.publishedSessions = {
      workspaces,
      history,
      addedCwds,
      unreadIds: new Set(this.unreadSessionIds),
      state,
    };
  }

  private reportAcquisitionError(error: unknown): void {
    if (this.disposed) return;
    this.deps.log?.error(`Failed to read Pi sessions: ${errorMessage(error)}`);
    if (this.view?.visible) this.post({ type: "sessionsError" });
  }

  private async refreshSessions(manual: boolean): Promise<void> {
    const version = this.refreshVersion;
    if (this.view?.visible) {
      this.post({
        type: "loading",
        manual,
        displayedSessionId: this.deps.registry.displayedSessionId ?? null,
      });
    }
    try {
      const workspaces = await this.readWorkspaces();
      if (this.disposed || version !== this.refreshVersion) return;
      if (!(await this.acceptWorkspaces(workspaces, version))) return;
      if (this.view?.visible) await this.refreshHistory();
    } catch (error) {
      if (this.disposed) return;
      if (version === this.refreshVersion) {
        this.listFailed = true;
        this.reportAcquisitionError(error);
      }
    }
  }

  private updateUnread(
    sessions: readonly Pick<SessionSummary, "sessionId">[],
    snapshot: {
      archivedIds: ReadonlySet<string>;
      livePhases: ReadonlyMap<string, SessionPhase> | null;
    },
  ): void {
    const runningIds = new Set<string>();
    const unreadIds = new Set<string>();
    const runningObservations = new Map<string, symbol>();
    for (const { sessionId } of sessions) {
      if (snapshot.archivedIds.has(sessionId)) continue;
      const phase = snapshot.livePhases?.get(sessionId);
      const observation = phase === "running" ? Symbol() : this.runningObservations.get(sessionId);
      if (observation !== undefined && (phase !== undefined || snapshot.livePhases === null)) {
        runningObservations.set(sessionId, observation);
      }
      const hasObservedRun = this.runningSessionIds.has(sessionId);
      if (snapshot.livePhases === null) {
        if (hasObservedRun) runningIds.add(sessionId);
        if (this.unreadSessionIds.has(sessionId)) unreadIds.add(sessionId);
        continue;
      }
      if (phase === "running" || (phase === "waiting-approval" && hasObservedRun)) {
        runningIds.add(sessionId);
      }
      const isUnreadCompletion =
        phase === "waiting-user" && (hasObservedRun || this.unreadSessionIds.has(sessionId));
      if (isUnreadCompletion) unreadIds.add(sessionId);
    }
    this.runningSessionIds = runningIds;
    this.runningObservations = runningObservations;
    this.unreadSessionIds = unreadIds;
  }

  private async livePhases(): Promise<Map<string, SessionPhase> | null> {
    try {
      return phasesFromWorkspaces(await this.deps.registry.mux.list());
    } catch {
      return null;
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const request = parseWebviewRequest(message);
    if (request === undefined) return;
    if (request.type === "ready") {
      if (request.requestId !== undefined) {
        if (this.latestListMessage !== undefined)
          this.post({ ...this.latestListMessage, requestId: request.requestId });
        return;
      }
      if (this.latestListMessage !== undefined) this.post(this.latestListMessage);
      await this.pendingRefresh;
      return;
    }
    if (request.type === "refresh") {
      await this.refreshManually();
      return;
    }
    if (request.type === "newSession") {
      let finished = false;
      const requestId = request.requestId;
      const post = this.post.bind(this);
      function finish(): void {
        if (finished || requestId === undefined) return;
        finished = true;
        post({ type: "newSessionFinished", requestId });
      }
      let previousSessionId: string | undefined;
      try {
        await requireWorkDirectory(request.cwd);
        previousSessionId = await this.deps.startNewSession(request.cwd, finish);
      } catch (error) {
        if (this.disposed || error instanceof DisplayRecoveryCancelledError) return;
        this.postError(`Failed to start Pi session in ${request.cwd}: ${errorMessage(error)}`);
        return;
      } finally {
        finish();
      }
      await this.deps.registry.run(() => this.stopTemporaryDisplayedSession(previousSessionId));
      await this.refresh(false);
      return;
    }
    if (request.type === "addWorkspace") {
      await this.deps.registry.run(() => this.addWorkspace(request.path));
      return;
    }
    if (request.type === "unregisterWorkspace") {
      this.deps.registry.cancelDisplayRecovery(request.cwd);
      for (const [controller, cwd] of this.pendingOpens) {
        if (cwdGroupKey(cwd) === cwdGroupKey(request.cwd)) controller.abort();
      }
      await this.deps.registry.run(() => this.unregisterWorkspace(request.cwd));
      return;
    }
    if (request.type === "openSession") {
      const selection = Symbol();
      this.latestSelection = selection;
      await this.queueOpenSession(request.sessionId, "select", selection);
      return;
    }
    if (request.type === "archiveSession") {
      try {
        await this.deps.registry.run(() => this.archiveSession(request.sessionId));
      } finally {
        if (request.requestId !== undefined)
          this.post({ type: "archiveFinished", requestId: request.requestId });
      }
      return;
    }
    if (request.type === "unarchiveSession") {
      try {
        await this.queueOpenSession(request.sessionId, "unarchive");
      } finally {
        if (request.requestId !== undefined)
          this.post({ type: "unarchiveFinished", requestId: request.requestId });
      }
      return;
    }
  }

  private async archiveSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    try {
      await this.deps.registry.stop(sessionId);
    } catch (error) {
      this.postError(
        `Failed to stop Pi session ${sessionId} in ${session.cwd}: ${errorMessage(error)}`,
      );
      return;
    }

    this.refreshVersion += 1;
    this.runningSessionIds.delete(sessionId);
    this.runningObservations.delete(sessionId);
    this.unreadSessionIds.delete(sessionId);
    if (this.state !== undefined) {
      this.postState({
        ...this.state,
        groups: this.state.groups.map((group) => ({
          ...group,
          sessions: group.sessions.map((row) =>
            row.sessionId === sessionId ? { ...row, state: undefined, hasUnread: false } : row,
          ),
        })),
        displayedSessionId: this.deps.registry.displayedSessionId,
      });
    }
    await this.refresh(false);
  }

  private postState(state: WebviewState): void {
    this.state = state;
    const stateJson = JSON.stringify(state);
    if (stateJson === this.postedStateJson) return;
    this.postedStateJson = stateJson;
    this.post({ type: "sessions", state });
  }

  private async addWorkspace(path: string): Promise<void> {
    let directory: string;
    try {
      directory = await requireWorkDirectory(expandWorkDirectoryInput(path));
    } catch (error) {
      this.postError(`Invalid workspace path: ${errorMessage(error)}`);
      return;
    }
    if (this.registeredCwds.has(directory)) {
      await this.deps.emptySessions?.resumeWorkspace(directory);
      this.post({ type: "workspaceAdded" });
      return;
    }
    try {
      await this.deps.registry.mux.registerWorkspace(directory);
      await this.deps.emptySessions?.resumeWorkspace(directory);
    } catch (error) {
      this.postError(`Failed to register workspace ${directory}: ${errorMessage(error)}`);
      return;
    }
    this.post({ type: "workspaceAdded" });
    await this.refresh(false);
  }

  private async unregisterWorkspace(cwd: string): Promise<void> {
    this.refreshVersion += 1;
    this.stopListPolling();
    try {
      await this.deps.emptySessions?.suspendWorkspace(cwd);
      await this.deps.registry.mux.unregisterWorkspace(cwd);
      this.deps.emptySessions?.completeUnregister(cwd);
      await this.updateAddedWorkspaces([], this.refreshVersion, cwd);
    } catch (error) {
      this.postError(`Failed to unregister workspace ${cwd}: ${errorMessage(error)}`);
      this.scheduleListRefresh();
      return;
    }
    await this.refresh(false);
  }

  private async queueOpenSession(
    sessionId: string,
    intent: "select" | "unarchive",
    selection?: symbol,
  ): Promise<void> {
    const controller = new AbortController();
    const present = this.deps.registry.preparePresentation();
    const cwd = this.sessionsById.get(sessionId)?.cwd;
    if (cwd !== undefined) this.pendingOpens.set(controller, cwd);
    try {
      await this.deps.registry.run(async () => {
        if (controller.signal.aborted) return;
        if (selection !== undefined && selection !== this.latestSelection) return;
        const session = this.sessionsById.get(sessionId);
        if (session === undefined) {
          this.postError(`Session not found: ${sessionId}`);
          return;
        }
        await this.openKnownSession(session, intent, controller.signal, present);
      });
    } finally {
      this.pendingOpens.delete(controller);
    }
  }

  private async openKnownSession(
    session: SessionSummary,
    intent: "select" | "unarchive",
    signal: AbortSignal,
    present: (terminal: vscode.Terminal) => void,
  ): Promise<void> {
    const previousSessionId = this.deps.registry.displayedSessionId;
    const { sessionId } = session;
    const temporary = intent === "select" && this.archivedSessionIds.has(sessionId);
    try {
      if (
        !(await sessionFileExists(session.filePath)) &&
        !(await this.deps.registry.mux.aliveSessionIds([sessionId]))?.has(sessionId)
      ) {
        if (signal.aborted) return;
        this.postError(`Session file no longer exists: ${sessionId}`);
        return;
      }
    } catch (error) {
      if (signal.aborted) return;
      this.postError(`Failed to read session file: ${errorMessage(error)}`);
      return;
    }

    let terminal: vscode.Terminal;
    try {
      signal.throwIfAborted();
      await requireWorkDirectory(session.cwd);
      signal.throwIfAborted();
      ({ terminal } = await this.deps.registry.open(
        {
          sessionId,
          cwd: session.cwd,
          ...(temporary ? { temporary: true as const } : {}),
        },
        intent,
        signal,
      ));
    } catch (error) {
      if (this.disposed || signal.aborted || error instanceof DisplayRecoveryCancelledError) return;
      this.postError(
        `Failed to open session ${sessionId} in ${session.cwd}: ${errorMessage(error)}`,
      );
      return;
    }

    if (signal.aborted) return;
    present(terminal);
    await this.deps.emptySessions?.resumeWorkspace(session.cwd);
    if (signal.aborted) return;
    if (temporary) this.temporarySessionIds.add(sessionId);
    else this.temporarySessionIds.delete(sessionId);
    await this.stopTemporaryDisplayedSession(previousSessionId);
    this.refreshVersion += 1;
    this.stopListPolling();
    const runningObservation = this.runningObservations.get(sessionId);
    const phases = await this.livePhases();
    if (runningObservation === this.runningObservations.get(sessionId)) {
      if (phases?.get(sessionId) === "waiting-user") {
        this.runningSessionIds.delete(sessionId);
      }
      this.unreadSessionIds.delete(sessionId);
    }
    await this.refresh(false);
  }

  private async stopTemporaryDisplayedSession(
    previousSessionId: string | undefined,
  ): Promise<void> {
    if (
      previousSessionId === undefined ||
      previousSessionId === this.deps.registry.displayedSessionId ||
      !this.temporarySessionIds.has(previousSessionId)
    ) {
      return;
    }
    try {
      await this.deps.registry.mux.closeTemporarySession(previousSessionId);
    } catch (error) {
      this.postError(
        `Failed to close temporary Pi session ${previousSessionId}: ${errorMessage(error)}`,
      );
    }
  }

  private post(message: ExtensionMessage): void {
    const isListMessage =
      message.type === "loading" || message.type === "sessions" || message.type === "sessionsError";
    const isReplay = isListMessage && message.requestId !== undefined;
    if (
      !isReplay &&
      (message.type === "loading" || message.type === "sessionsError" || message.type === "error")
    ) {
      this.postedStateJson = undefined;
    }
    if (isListMessage && !isReplay) this.latestListMessage = message;
    const view = this.view;
    if (view === undefined) return;
    function reportDeliveryFailure(): void {
      if (!isListMessage)
        void vscode.window.showErrorMessage("Failed to update the Sessions view.");
    }
    void view.webview.postMessage(message).then(
      (delivered) => {
        if (!delivered) {
          if (this.view === view) this.postedStateJson = undefined;
          reportDeliveryFailure();
        }
      },
      () => {
        if (this.view === view) this.postedStateJson = undefined;
        reportDeliveryFailure();
      },
    );
  }

  private postError(message: string): void {
    void vscode.window.showErrorMessage(message);
    this.post({ type: "error", message });
  }
}

function phasesFromWorkspaces(workspaces: readonly PiMuxWorkspace[]): Map<string, SessionPhase> {
  const phases = new Map<string, SessionPhase>();
  for (const { id, state, temporary } of flattenPiMuxSessions(workspaces)) {
    if (
      !temporary &&
      (state === "running" || state === "waiting-approval" || state === "waiting-user")
    )
      phases.set(id, state);
  }
  return phases;
}
