import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { registerWorkspace, unregisterWorkspace, type SessionPhase } from "../sessionStateStore";
import { listSessionSnapshot, sessionFileExists, type SessionSummary } from "../sessionStore";
import { expandWorkDirectoryInput, requireWorkDirectory } from "../workDirectory";
import type { TerminalRegistry } from "../terminalRegistry";
import { errorMessage } from "../guards";
import { archiveReplacement } from "../grouping";
import { flattenPiMuxSessions, type PiMuxWorkspace } from "../piMux";
import { parseWebviewRequest, type ExtensionMessage, type WebviewState } from "./protocol";
import { sessionViewGroups } from "./sessionViewData";
import { webviewHtml } from "./webviewHtml";

export const VIEW_ID = "piSessions.sessions";
const LIST_REFRESH_INTERVAL_MS = 1_000;

export interface SessionWebviewDeps {
  extensionUri: string;
  statePath: string;
  registry: TerminalRegistry;
  startNewSession: (cwd: string) => Promise<string | undefined>;
  onWorkspaces?: (cwds: readonly string[]) => void;
}

/** Owns the WebviewView and translates its fixed message protocol into extension actions. */
export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private sessionsById = new Map<string, SessionSummary>();
  private archivedSessionIds = new Set<string>();
  private temporarySessionIds = new Set<string>();
  private state: WebviewState | undefined;
  private runningSessionIds = new Set<string>();
  private runningObservations = new Map<string, symbol>();
  private unreadSessionIds = new Set<string>();
  private refreshVersion = 0;
  private latestSelection: symbol | undefined;
  private pendingRefresh: Promise<void> | undefined;
  private refreshRequested = false;
  private loadingRequested = false;
  private disposed = false;
  private listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private latestListMessage:
    | Extract<ExtensionMessage, { type: "loading" | "sessions" | "sessionsError" }>
    | undefined;

  constructor(private readonly deps: SessionWebviewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.stopListPolling();
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
      if (webviewView.visible) void this.refresh();
    });
    webviewView.webview.html = webviewHtml({
      scriptUri: scriptUri.toString(),
      nonce: randomBytes(16).toString("base64"),
    });
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.stopListPolling();
    this.view = undefined;
    this.runningSessionIds.clear();
    this.runningObservations.clear();
    this.unreadSessionIds.clear();
    this.refreshVersion += 1;
  }

  async refresh(): Promise<void> {
    return this.requestRefresh(true);
  }

  private async requestRefresh(showLoading = false): Promise<void> {
    if (this.disposed) return;
    this.stopListPolling();
    this.refreshVersion += 1;
    this.refreshRequested = true;
    this.loadingRequested ||= showLoading;
    if (this.pendingRefresh !== undefined) return this.pendingRefresh;
    const pending = this.drainRefreshes();
    this.pendingRefresh = pending;
    try {
      await pending;
    } finally {
      this.pendingRefresh = undefined;
      this.scheduleListRefresh();
    }
  }

  private async drainRefreshes(): Promise<void> {
    while (this.refreshRequested && !this.disposed) {
      this.refreshRequested = false;
      const showLoading = this.loadingRequested;
      this.loadingRequested = false;
      await this.refreshSessions(showLoading);
    }
  }

  private stopListPolling(): void {
    clearTimeout(this.listRefreshTimer);
    this.listRefreshTimer = undefined;
  }

  private scheduleListRefresh(): void {
    if (this.disposed || this.pendingRefresh !== undefined) return;
    this.stopListPolling();
    this.listRefreshTimer = setTimeout(() => void this.requestRefresh(), LIST_REFRESH_INTERVAL_MS);
    this.listRefreshTimer.unref();
  }

  private async refreshSessions(showLoading: boolean): Promise<void> {
    const version = this.refreshVersion;
    if (showLoading && this.view?.visible) {
      this.post({
        type: "loading",
        displayedSessionId: this.deps.registry.displayedSessionId ?? null,
      });
    }
    try {
      const workspaces = await this.deps.registry.mux.list();
      if (this.disposed || version !== this.refreshVersion) return;
      this.deps.onWorkspaces?.(workspaces.map(({ cwd }) => cwd));
      const live = flattenPiMuxSessions(workspaces);
      this.temporarySessionIds = new Set(
        live.filter((session) => session.temporary).map(({ id }) => id),
      );
      const phases = phasesFromWorkspaces(workspaces);
      if (!this.view?.visible) {
        this.updateUnread(
          flattenPiMuxSessions(workspaces).map(({ id }) => ({ sessionId: id })),
          {
            archivedIds: this.temporarySessionIds,
            livePhases: phases,
          },
        );
        return;
      }
      const { sessions, registeredCwds, archivedIds } = await listSessionSnapshot(
        this.deps.registry.mux,
        workspaces,
      );
      if (this.disposed || !this.view?.visible || version !== this.refreshVersion) return;
      this.updateUnread(sessions, { archivedIds, livePhases: phases });
      this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
      this.archivedSessionIds = archivedIds;
      this.postState({
        groups: sessionViewGroups(sessions, {
          registeredCwds,
          archivedIds,
          phases,
          unreadIds: this.unreadSessionIds,
        }),
        displayedSessionId: this.deps.registry.displayedSessionId,
      });
    } catch (error) {
      if (!this.disposed && version === this.refreshVersion) {
        const message = `Failed to read Pi sessions: ${errorMessage(error)}`;
        if (this.view?.visible) this.postError(message, "sessionsError");
        else void vscode.window.showErrorMessage(message);
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
      if (this.latestListMessage !== undefined) this.post(this.latestListMessage);
      await this.pendingRefresh;
      return;
    }
    if (request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "newSession") {
      let previousSessionId: string | undefined;
      try {
        await requireWorkDirectory(request.cwd);
        previousSessionId = await this.deps.startNewSession(request.cwd);
      } catch (error) {
        this.postError(`Failed to start Pi session in ${request.cwd}: ${errorMessage(error)}`);
        return;
      }
      await this.deps.registry.run(() => this.stopTemporaryDisplayedSession(previousSessionId));
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
      await this.deps.registry.run(() => this.openSession(request.sessionId, "unarchive"));
      return;
    }
  }

  private async archiveSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    let replacement: SessionSummary | undefined;
    let confirmedDisplay: vscode.Terminal | undefined;
    let switchError: string | undefined;
    try {
      confirmedDisplay = await this.deps.registry.displayForSession(sessionId);
      if (confirmedDisplay !== undefined) {
        const snapshot = await listSessionSnapshot(
          this.deps.registry.mux,
          await this.deps.registry.mux.list(),
        );
        replacement = archiveReplacement(snapshot.sessions, snapshot.archivedIds, session);
      }
    } catch (error) {
      switchError = `Failed to find another Pi session in ${session.cwd}: ${errorMessage(error)}`;
    }
    let switched = false;
    try {
      const stopped = await this.deps.registry.stop(sessionId, { replacement, confirmedDisplay });
      switched = stopped.switched;
      if (stopped.switchError !== undefined) {
        switchError = `Failed to switch Pi session after archiving ${sessionId}: ${stopped.switchError}`;
      }
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
    if (switched && replacement !== undefined) this.unreadSessionIds.delete(replacement.sessionId);
    if (switchError !== undefined) this.postError(switchError);
    await this.refresh();
  }

  private postState(state: WebviewState): void {
    this.state = state;
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
    const result = registerWorkspace(this.deps.statePath, directory);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    this.post({ type: "workspaceAdded" });
    await this.refresh();
  }

  private unregisterWorkspace(cwd: string): void {
    const result = unregisterWorkspace(this.deps.statePath, cwd);
    if (!result.ok) {
      this.postError(result.message);
    }
  }

  private async openSession(
    sessionId: string,
    intent: "select" | "unarchive" = "select",
  ): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    await this.openKnownSession(session, intent);
  }

  private async openKnownSession(
    session: SessionSummary,
    intent: "select" | "unarchive",
  ): Promise<void> {
    const previousSessionId = this.deps.registry.displayedSessionId;
    const { sessionId } = session;
    const temporary = intent === "select" && this.archivedSessionIds.has(sessionId);
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
      ({ terminal } = await this.deps.registry.open(
        {
          sessionId,
          cwd: session.cwd,
          ...(temporary ? { temporary: true as const } : {}),
        },
        intent,
      ));
    } catch (error) {
      this.postError(
        `Failed to open session ${sessionId} in ${session.cwd}: ${errorMessage(error)}`,
      );
      return;
    }

    terminal.show();
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
    await this.refresh();
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
