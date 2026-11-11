import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  activeSessionIds,
  archiveSessions,
  readSessionStateStore,
  registerWorkspace,
  registeredWorkspaceCwds,
  unarchiveSessions,
  unregisterWorkspace,
  type SessionPhase,
  type SessionRef,
  type SessionStateUpdateResult,
} from "../sessionStateStore";
import { listSessions, sessionFileExists, type SessionSummary } from "../sessionStore";
import { expandWorkDirectoryInput, requireWorkDirectory } from "../workDirectory";
import type { TerminalRegistry } from "../terminalRegistry";
import { errorMessage } from "../guards";
import { parseWebviewRequest, type ExtensionMessage, type WebviewState } from "./protocol";
import { sessionViewGroups } from "./sessionViewData";
import { webviewHtml } from "./webviewHtml";

export const VIEW_ID = "piSessions.sessions";
const PHASE_REFRESH_INTERVAL_MS = 1_000;

export interface SessionWebviewDeps {
  extensionUri: string;
  sessionDir: string;
  /** Session state store, shared with the pi extension `session-state`. */
  statePath: string;
  registry: TerminalRegistry;
  startNewSession: (cwd: string) => Promise<void>;
}

/** Owns the WebviewView and translates its fixed message protocol into extension actions. */
export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private sessionsById = new Map<string, SessionSummary>();
  private state: WebviewState | undefined;
  private runningSessionIds = new Set<string>();
  private runningObservations = new Map<string, symbol>();
  private unreadSessionIds = new Set<string>();
  private refreshVersion = 0;
  private latestSelection: symbol | undefined;
  private pendingRefresh: Promise<void> | undefined;
  private pendingPhaseRefresh: Promise<void> | undefined;
  private phaseRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private phaseRefreshVersion = 0;
  private latestListMessage:
    | Extract<ExtensionMessage, { type: "loading" | "sessions" | "sessionsError" }>
    | undefined;

  constructor(private readonly deps: SessionWebviewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.stopPhasePolling();
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
      this.stopPhasePolling();
      this.view = undefined;
      this.refreshVersion += 1;
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    webviewView.onDidChangeVisibility(() => {
      if (this.view !== webviewView) return;
      this.stopPhasePolling();
      if (webviewView.visible) void this.refresh();
    });
    webviewView.webview.html = webviewHtml({
      scriptUri: scriptUri.toString(),
      nonce: randomBytes(16).toString("base64"),
    });
    void this.refresh();
  }

  dispose(): void {
    this.stopPhasePolling();
    this.view = undefined;
    this.runningSessionIds.clear();
    this.runningObservations.clear();
    this.unreadSessionIds.clear();
    this.refreshVersion += 1;
  }

  /** Re-read the session state store and the registered groups' session
   * files, then send display-only data to the webview. */
  async refresh(): Promise<void> {
    this.stopPhasePolling();
    const pending = this.refreshSessions();
    this.pendingRefresh = pending;
    try {
      await pending;
    } finally {
      if (this.pendingRefresh === pending) {
        this.pendingRefresh = undefined;
        this.schedulePhaseRefresh();
      }
    }
  }

  private stopPhasePolling(): void {
    clearTimeout(this.phaseRefreshTimer);
    this.phaseRefreshTimer = undefined;
    this.phaseRefreshVersion += 1;
  }

  private schedulePhaseRefresh(): void {
    if (
      !this.view?.visible ||
      this.pendingRefresh !== undefined ||
      this.pendingPhaseRefresh !== undefined ||
      this.latestListMessage?.type !== "sessions"
    )
      return;
    clearTimeout(this.phaseRefreshTimer);
    this.phaseRefreshTimer = setTimeout(() => void this.refreshPhases(), PHASE_REFRESH_INTERVAL_MS);
    this.phaseRefreshTimer.unref();
  }

  private async refreshPhases(): Promise<void> {
    this.phaseRefreshTimer = undefined;
    if (
      !this.view?.visible ||
      this.pendingRefresh !== undefined ||
      this.pendingPhaseRefresh !== undefined
    )
      return;
    const pending = this.updateLivePhases();
    this.pendingPhaseRefresh = pending;
    try {
      await pending;
    } finally {
      this.pendingPhaseRefresh = undefined;
      this.schedulePhaseRefresh();
    }
  }

  private async updateLivePhases(): Promise<void> {
    const state = this.state;
    if (state === undefined) return;
    const version = this.refreshVersion;
    const phaseVersion = this.phaseRefreshVersion;
    const phases = await this.livePhases();
    if (
      !this.view?.visible ||
      this.state !== state ||
      version !== this.refreshVersion ||
      phaseVersion !== this.phaseRefreshVersion
    )
      return;
    const archivedIds = new Set(
      state.groups.flatMap((group) =>
        group.sessions.filter((session) => session.isArchived).map((session) => session.sessionId),
      ),
    );
    this.updateUnread([...this.sessionsById.values()], { archivedIds, livePhases: phases });
    this.postState({
      ...state,
      groups: state.groups.map((group) => ({
        ...group,
        sessions: group.sessions.map((session) => ({
          ...session,
          state: session.isArchived ? undefined : phases?.get(session.sessionId),
          hasUnread: this.unreadSessionIds.has(session.sessionId),
        })),
      })),
      displayedSessionId: this.deps.registry.displayedSessionId,
    });
  }

  private async refreshSessions(): Promise<void> {
    const version = ++this.refreshVersion;
    this.post({
      type: "loading",
      displayedSessionId: this.deps.registry.displayedSessionId ?? null,
    });
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") {
      this.postError(store.message, "sessionsError");
      return;
    }
    const data = store.status === "ok" ? store.data : undefined;
    const activeIds = activeSessionIds(data);
    const registeredCwds = registeredWorkspaceCwds(data);

    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir, { cwds: registeredCwds });
    } catch (error) {
      if (version === this.refreshVersion) {
        this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`, "sessionsError");
      }
      return;
    }

    // Whitelist semantics: a scanned session the active map does not list is
    // inactive (archived) and only visible in the All view.
    const archivedIds = new Set(
      sessions.map((session) => session.sessionId).filter((id) => !activeIds.has(id)),
    );
    const phases = await this.livePhases();
    if (version !== this.refreshVersion) return;
    for (const sessionId of archivedIds) phases?.delete(sessionId);
    this.updateUnread(sessions, { archivedIds, livePhases: phases });
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    this.postState({
      groups: sessionViewGroups(sessions, {
        registeredCwds,
        archivedIds,
        phases: phases ?? new Map(),
        unreadIds: this.unreadSessionIds,
      }),
      displayedSessionId: this.deps.registry.displayedSessionId,
    });
  }

  private updateUnread(
    sessions: readonly SessionSummary[],
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
      const phases = new Map<string, SessionPhase>();
      for (const { id, state: phase } of await this.deps.registry.mux.list()) {
        if (phase === "running" || phase === "waiting-approval" || phase === "waiting-user") {
          phases.set(id, phase);
        }
      }
      return phases;
    } catch {
      return null;
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const request = parseWebviewRequest(message);
    if (request === undefined) return;
    if (request.type === "ready") {
      if (this.latestListMessage !== undefined) this.post(this.latestListMessage);
      await this.pendingRefresh;
      return;
    }
    if (request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "newSession") {
      const previousSessionId = this.deps.registry.displayedSessionId;
      try {
        await requireWorkDirectory(request.cwd);
        await this.deps.startNewSession(request.cwd);
      } catch (error) {
        this.postError(`Failed to start Pi session in ${request.cwd}: ${errorMessage(error)}`);
        return;
      }
      // The launch replaced the shared display; stop an archived previous
      // display the same way a switch away from it does. A separate
      // registry.run is required because nesting it inside startNewSession's
      // own run would wait on that run forever.
      await this.deps.registry.run(() => this.stopArchivedDisplayedSession(previousSessionId));
      await this.refresh();
      return;
    }
    if (request.type === "addWorkspace") {
      await this.addWorkspace(request.path);
      return;
    }
    if (request.type === "unregisterWorkspace") {
      this.unregisterWorkspace(request.cwd);
      await this.refresh();
      return;
    }
    if (request.type === "openSession") {
      const selection = Symbol();
      this.latestSelection = selection;
      await this.deps.registry.run(async () => {
        if (selection !== this.latestSelection) return;
        await this.openSession(request.sessionId);
      });
      return;
    }
    if (request.type === "archiveSession") {
      await this.deps.registry.run(() => this.archiveSession(request.sessionId));
      return;
    }
    if (request.type === "unarchiveSession") {
      await this.deps.registry.run(async () => {
        const session = await this.updateKnownSession(request.sessionId, (ref) =>
          unarchiveSessions(this.deps.statePath, [ref]),
        );
        if (session === undefined) return;
        await this.openKnownSession(session);
      });
      return;
    }
  }

  private async archiveSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") {
      this.postError(store.message);
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
    const result = archiveSessions(this.deps.statePath, [{ sessionId, cwd: session.cwd }]);
    if (!result.ok) {
      this.postError(
        `Pi session ${sessionId} stopped, but failed to save archive: ${result.message}`,
      );
      return;
    }
    await this.refresh();
  }

  private postState(state: WebviewState): void {
    this.state = state;
    this.post({ type: "sessions", state });
  }

  private async updateKnownSession(
    sessionId: string,
    update: (ref: SessionRef) => SessionStateUpdateResult,
  ): Promise<SessionSummary | undefined> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return undefined;
    }
    const result = update({ sessionId, cwd: session.cwd });
    if (!result.ok) {
      this.postError(result.message);
      return undefined;
    }
    await this.refresh();
    return session;
  }

  /** Register a workspace folder: create its store entry when the cwd has
   * none, then show the list. Invalid paths answer with an error and leave
   * the store unchanged; an already registered cwd only closes the webview's
   * form (via the refreshed list message). */
  private async addWorkspace(path: string): Promise<void> {
    let directory: string;
    try {
      directory = await requireWorkDirectory(expandWorkDirectoryInput(path));
    } catch (error) {
      this.postError(`Invalid workspace path: ${errorMessage(error)}`);
      return;
    }
    const result = registerWorkspace(this.deps.statePath, directory);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    await this.refresh();
  }

  private unregisterWorkspace(cwd: string): void {
    const result = unregisterWorkspace(this.deps.statePath, cwd);
    if (!result.ok) {
      this.postError(result.message);
    }
  }

  private async openSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    await this.openKnownSession(session);
  }

  private async openKnownSession(session: SessionSummary): Promise<void> {
    const previousSessionId = this.deps.registry.displayedSessionId;
    const { sessionId } = session;
    try {
      if (
        !(await sessionFileExists(session.filePath)) &&
        !(await this.deps.registry.mux.aliveSessionIds([sessionId]))?.has(sessionId)
      ) {
        this.postError(`Session file no longer exists: ${sessionId}`);
        return;
      }
    } catch (error) {
      this.postError(`Failed to read session file: ${errorMessage(error)}`);
      return;
    }

    let terminal: vscode.Terminal;
    try {
      await requireWorkDirectory(session.cwd);
      ({ terminal } = await this.deps.registry.open({
        sessionId,
        cwd: session.cwd,
      }));
    } catch (error) {
      this.postError(
        `Failed to open session ${sessionId} in ${session.cwd}: ${errorMessage(error)}`,
      );
      return;
    }

    terminal.show();
    await this.stopArchivedDisplayedSession(previousSessionId);
    this.refreshVersion += 1;
    this.stopPhasePolling();
    const runningObservation = this.runningObservations.get(sessionId);
    const phases = await this.livePhases();
    if (runningObservation === this.runningObservations.get(sessionId)) {
      if (phases?.get(sessionId) === "waiting-user") {
        this.runningSessionIds.delete(sessionId);
      }
      this.unreadSessionIds.delete(sessionId);
    }
    // Re-send the list so the webview's selection display follows the
    // session the shared terminal now shows.
    await this.refresh();
  }

  /** Stop the tmux session of the previously displayed session when it is
   * still archived after the shared display moved to another session.
   * Opening an archived session may keep its Pi alive while it stays
   * displayed, but leaving it without unarchiving must not keep that Pi
   * running. The display must have actually moved: an unchanged or lost
   * display (failed open or launch) keeps the previous Pi. A store read
   * error keeps it too because the archived state cannot be confirmed. */
  private async stopArchivedDisplayedSession(previousSessionId: string | undefined): Promise<void> {
    if (
      previousSessionId === undefined ||
      previousSessionId === this.deps.registry.displayedSessionId
    ) {
      return;
    }
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") return;
    if (activeSessionIds(store.status === "ok" ? store.data : undefined).has(previousSessionId)) {
      return;
    }
    try {
      await this.deps.registry.stop(previousSessionId);
    } catch (error) {
      this.postError(
        `Failed to stop archived Pi session ${previousSessionId}: ${errorMessage(error)}`,
      );
    }
  }

  private post(message: ExtensionMessage): void {
    if (
      message.type === "loading" ||
      message.type === "sessions" ||
      message.type === "sessionsError"
    ) {
      this.latestListMessage = message;
    }
    const view = this.view;
    if (view === undefined) return;
    void view.webview.postMessage(message).then(
      (delivered) => {
        if (!delivered) void vscode.window.showErrorMessage("Failed to update the Sessions view.");
      },
      () => void vscode.window.showErrorMessage("Failed to update the Sessions view."),
    );
  }

  private postError(message: string, type: "error" | "sessionsError" = "error"): void {
    void vscode.window.showErrorMessage(message);
    this.post({ type, message });
  }
}
