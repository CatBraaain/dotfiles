import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  activeSessionIds,
  archiveSessions,
  lockedSessionIds,
  readSessionStateStore,
  registerWorkspace,
  registeredWorkspaceCwds,
  sessionPhases,
  setSessionLocks,
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
import { parseWebviewRequest, type ExtensionMessage } from "./protocol";
import { sessionViewGroups } from "./sessionViewData";
import { webviewHtml } from "./webviewHtml";

export const VIEW_ID = "piSessions.sessions";

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

  constructor(private readonly deps: SessionWebviewDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
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
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.view === webviewView) void this.refresh();
    });
    webviewView.webview.html = webviewHtml({
      scriptUri: scriptUri.toString(),
      nonce: randomBytes(16).toString("base64"),
    });
    void this.refresh();
  }

  dispose(): void {
    this.view = undefined;
  }

  /** Re-read the session state store and the registered groups' session
   * files, then send display-only data to the webview. */
  async refresh(): Promise<void> {
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") {
      this.postError(store.message);
      return;
    }
    const data = store.status === "ok" ? store.data : undefined;
    const activeIds = activeSessionIds(data);
    const lockedIds = lockedSessionIds(data);
    const registeredCwds = registeredWorkspaceCwds(data);

    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir, { cwds: registeredCwds });
    } catch (error) {
      this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`);
      return;
    }

    // Whitelist semantics: a scanned session the active map does not list is
    // inactive (archived) and only visible in the All view.
    const archivedIds = new Set(
      sessions.map((session) => session.sessionId).filter((id) => !activeIds.has(id)),
    );
    const phases = await this.livePhases(sessionPhases(data));
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    this.post({
      type: "sessions",
      state: {
        groups: sessionViewGroups(sessions, {
          registeredCwds,
          archivedIds,
          lockedIds,
          phases,
        }),
        displayedSessionId: this.deps.registry.displayedSessionId,
      },
    });
  }

  /** Drop the phases of sessions whose Pi tmux session has no live pane
   * (stale entries left behind by abnormally terminated Pi; the entries
   * themselves stay in the store). When tmux cannot be queried, no phase is
   * shown. */
  private async livePhases(
    storePhases: ReadonlyMap<string, SessionPhase>,
  ): Promise<Map<string, SessionPhase>> {
    const phases = new Map<string, SessionPhase>();
    if (storePhases.size === 0) return phases;
    const aliveIds = await this.deps.registry.runtimes.aliveSessionIds([...storePhases.keys()]);
    if (aliveIds === null) return phases;
    for (const [sessionId, phase] of storePhases) {
      if (aliveIds.has(sessionId)) phases.set(sessionId, phase);
    }
    return phases;
  }

  private async handleMessage(message: unknown): Promise<void> {
    const request = parseWebviewRequest(message);
    if (request === undefined) return;
    if (request.type === "ready" || request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "newSession") {
      try {
        await requireWorkDirectory(request.cwd);
        await this.deps.startNewSession(request.cwd);
      } catch (error) {
        this.postError(`Failed to start Pi session in ${request.cwd}: ${errorMessage(error)}`);
      }
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
    if (request.type === "copySessionId") {
      try {
        await vscode.env.clipboard.writeText(request.sessionId);
      } catch (error) {
        this.postError(`Failed to copy session ID: ${errorMessage(error)}`);
      }
      return;
    }
    if (request.type === "openSession") {
      await this.deps.registry.run(() => this.openSession(request.sessionId));
      return;
    }
    if (request.type === "setSessionLock") {
      await this.updateKnownSession(request.sessionId, (ref) =>
        setSessionLocks(this.deps.statePath, [{ ...ref, locked: request.locked }]),
      );
      return;
    }
    if (request.type === "archiveSession") {
      await this.updateKnownSession(request.sessionId, (ref) =>
        archiveSessions(this.deps.statePath, [ref]),
      );
      return;
    }
    if (request.type === "unarchiveSession") {
      await this.updateKnownSession(request.sessionId, (ref) =>
        unarchiveSessions(this.deps.statePath, [ref]),
      );
      return;
    }
  }

  /** Run a single session's store update: validate the session id, apply the
   * update in one write, then refresh. An unknown id answers with an error
   * and leaves the store unchanged. */
  private async updateKnownSession(
    sessionId: string,
    update: (ref: SessionRef) => SessionStateUpdateResult,
  ): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session === undefined) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    const result = update({ sessionId, cwd: session.cwd });
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    await this.refresh();
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

  /** Drop the workspace registration: delete its store entry together with
   * its session memberships. The webview asks for confirmation before sending
   * the request; the group disappears from the list and a sessionless
   * registration too. A Pi still running in the cwd recreates the entry on
   * its next sent message. */
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
    try {
      if (!(await sessionFileExists(session.filePath))) {
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
        args: ["--session", session.filePath],
      }));
    } catch (error) {
      this.postError(
        `Failed to open session ${sessionId} in ${session.cwd}: ${errorMessage(error)}`,
      );
      return;
    }

    terminal.show();
    // Re-send the list so the webview's selection display follows the
    // session the shared terminal now shows.
    await this.refresh();
  }

  private post(message: ExtensionMessage): void {
    const view = this.view;
    if (view === undefined) return;
    void view.webview.postMessage(message).then(
      (delivered) => {
        if (!delivered) void vscode.window.showErrorMessage("Failed to update the Sessions view.");
      },
      () => void vscode.window.showErrorMessage("Failed to update the Sessions view."),
    );
  }

  private postError(message: string): void {
    void vscode.window.showErrorMessage(message);
    this.post({ type: "error", message });
  }
}
