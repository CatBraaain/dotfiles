import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  archivedSessionIds,
  archiveSessions,
  lockedSessionIds,
  readMetadataStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  setSessionActive,
  setSessionLocked,
  unregisterWorkspace,
} from "../metadataStore";
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
  metadataPath: string;
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

  /** Re-read sessions and metadata, then send display-only data to the webview. */
  async refresh(): Promise<void> {
    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir);
    } catch (error) {
      this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`);
      return;
    }

    const metadata = readMetadataStore(this.deps.metadataPath);
    if (metadata.status === "error") {
      this.postError(metadata.message);
      return;
    }

    const archivedIds =
      metadata.status === "ok" ? archivedSessionIds(metadata.data) : new Set<string>();
    const lockedIds =
      metadata.status === "ok" ? lockedSessionIds(metadata.data) : new Set<string>();
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    const metadataCwds = metadata.status === "ok" ? registeredWorkspaceCwds(metadata.data) : [];
    this.post({
      type: "sessions",
      state: { groups: sessionViewGroups(sessions, metadataCwds, archivedIds, lockedIds) },
    });
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
      await this.unregisterWorkspace(request.cwd);
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
      if (!this.sessionsById.has(request.sessionId)) {
        this.postError(`Session not found: ${request.sessionId}`);
        return;
      }
      const result = setSessionLocked(this.deps.metadataPath, request.sessionId, request.locked);
      if (!result.ok) {
        this.postError(result.message);
        return;
      }
      await this.refresh();
      return;
    }
    if (request.type === "archiveSessions") {
      const sessionIds = [...new Set(request.sessionIds)];
      const unknown = sessionIds.find((sessionId) => !this.sessionsById.has(sessionId));
      if (unknown !== undefined) {
        this.postError(`Session not found: ${unknown}`);
        return;
      }
      const result = archiveSessions(this.deps.metadataPath, sessionIds);
      if (!result.ok) {
        this.postError(result.message);
        return;
      }
      await this.refresh();
      return;
    }
  }

  /** Register a workspace folder in the metadata store, then show the list.
   * Invalid paths answer with an error and leave the store unchanged; a cwd
   * already registered only closes the webview's form (via the refreshed list
   * message). */
  private async addWorkspace(path: string): Promise<void> {
    let directory: string;
    try {
      directory = await requireWorkDirectory(expandWorkDirectoryInput(path));
    } catch (error) {
      this.postError(`Invalid workspace path: ${errorMessage(error)}`);
      return;
    }
    const metadata = readMetadataStore(this.deps.metadataPath);
    if (metadata.status === "error") {
      this.postError(metadata.message);
      return;
    }
    const alreadyListed = registeredWorkspaceCwds(
      metadata.status === "ok" ? metadata.data : undefined,
    ).includes(directory);
    if (!alreadyListed) {
      const result = registerWorkspace(this.deps.metadataPath, directory, Date.now());
      if (!result.ok) {
        this.postError(result.message);
        return;
      }
    }
    await this.refresh();
  }

  /** Drop the workspace registration. The webview asks for confirmation
   * before sending the request; the group disappears from the list (registered
   * workspaces are the whitelist) and a sessionless registration too. */
  private async unregisterWorkspace(cwd: string): Promise<void> {
    const result = unregisterWorkspace(this.deps.metadataPath, cwd);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    await this.refresh();
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

    const result = setSessionActive(this.deps.metadataPath, sessionId, true);
    if (!result.ok) {
      this.postError(result.message);
      terminal.show();
      return;
    }
    await this.refresh();
    terminal.show();
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
