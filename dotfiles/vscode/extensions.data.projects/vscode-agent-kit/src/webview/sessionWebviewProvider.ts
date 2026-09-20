import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { activeSessionIds, readMetadataStore, setSessionActive } from "../metadataStore";
import { listSessions, sessionFileExists, type SessionSummary } from "../sessionStore";
import { createSessionTerminal } from "../terminals";
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
  startNewSession: () => Promise<void>;
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
    const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(clientRoot, "webview", "client.js"));
    webviewView.webview.html = webviewHtml({
      scriptUri: scriptUri.toString(),
      nonce: randomBytes(16).toString("base64"),
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
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

    const activeIds = metadata.status === "ok" ? activeSessionIds(metadata.data) : new Set<string>();
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    this.post({
      type: "sessions",
      state: { groups: sessionViewGroups(sessions, activeIds) },
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const request = parseWebviewRequest(message);
    if (request === undefined) return;
    if (request.type === "refresh") {
      await this.refresh();
      return;
    }
    if (request.type === "newSession") {
      await this.deps.startNewSession();
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
      await this.openSession(request.sessionId);
      return;
    }
    await this.archiveSession(request.sessionId);
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

    const terminal = this.deps.registry.get(sessionId) ?? createSessionTerminal(session);
    this.deps.registry.set(sessionId, terminal);
    terminal.show();

    const result = setSessionActive(this.deps.metadataPath, sessionId, true);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    await this.refresh();
  }

  private async archiveSession(sessionId: string): Promise<void> {
    if (!this.sessionsById.has(sessionId)) {
      this.postError(`Session not found: ${sessionId}`);
      return;
    }
    const result = setSessionActive(this.deps.metadataPath, sessionId, false);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
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
