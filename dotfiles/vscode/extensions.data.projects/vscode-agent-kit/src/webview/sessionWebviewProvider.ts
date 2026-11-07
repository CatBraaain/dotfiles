import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  archivedSessionIds,
  archivedSessionNames,
  archiveSessions,
  lockedSessionIds,
  readMetadataStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  setSessionLocked,
  unarchiveSessions,
  unregisterWorkspace,
  type ArchiveEntry,
  type MetadataUpdateResult,
} from "../metadataStore";
import { listSessions, sessionFileExists, type SessionSummary } from "../sessionStore";
import { cwdGroupKey } from "../grouping";
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

  /** Re-read sessions and metadata, then send display-only data to the webview.
   * Scans only the registered workspaces' cwd groups; archived sessions with a
   * display-name snapshot skip reading their session file's body. */
  async refresh(): Promise<void> {
    const metadata = readMetadataStore(this.deps.metadataPath);
    if (metadata.status === "error") {
      this.postError(metadata.message);
      return;
    }
    const data = metadata.status === "ok" ? metadata.data : undefined;
    const archivedIds = archivedSessionIds(data);
    const lockedIds = lockedSessionIds(data);
    const archivedNames = archivedSessionNames(data);
    const metadataCwds = registeredWorkspaceCwds(data);

    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir, {
        cwds: metadataCwds,
        archivedNames,
      });
    } catch (error) {
      this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`);
      return;
    }

    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
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
      // Archive snapshots each session's current display name, so the batch is
      // built from the scanned summaries before the metadata update runs.
      await this.updateKnownSessions(request.sessionIds, (path, ids) =>
        archiveSessions(
          path,
          ids.map((sessionId) => ({
            sessionId,
            displayName: this.sessionsById.get(sessionId)?.displayName ?? "Untitled",
          })),
        ),
      );
      return;
    }
    if (request.type === "unarchiveSessions") {
      await this.updateKnownSessions(request.sessionIds, unarchiveSessions);
      return;
    }
  }

  /** Run a known-ids archive/unarchive batch: validate the session ids,
   * update the metadata store in one write, then refresh. Unknown ids answer
   * with an error and leave the store unchanged. */
  private async updateKnownSessions(
    sessionIds: readonly string[],
    update: (path: string, sessionIds: readonly string[]) => MetadataUpdateResult,
  ): Promise<void> {
    const uniqueIds = [...new Set(sessionIds)];
    const unknown = uniqueIds.find((sessionId) => !this.sessionsById.has(sessionId));
    if (unknown !== undefined) {
      this.postError(`Session not found: ${unknown}`);
      return;
    }
    const result = update(this.deps.metadataPath, uniqueIds);
    if (!result.ok) {
      this.postError(result.message);
      return;
    }
    await this.refresh();
  }

  /** Register a workspace folder in the metadata store, then show the list.
   * Invalid paths answer with an error and leave the store unchanged; a cwd
   * already registered only closes the webview's form (via the refreshed list
   * message). A new registration archives the workspace's existing sessions
   * (with a display-name snapshot each) so the list starts clean and future
   * scans skip their bodies. */
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
      await this.archiveExistingSessions(directory);
    }
    await this.refresh();
  }

  /** Archive every session whose header cwd belongs to the given workspace
   * cwd, snapshotting each display name in one metadata write. Scan or write
   * errors are surfaced but never undo the registration. */
  private async archiveExistingSessions(cwd: string): Promise<void> {
    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir, { cwds: [cwd] });
    } catch (error) {
      this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`);
      return;
    }
    const key = cwdGroupKey(cwd);
    const entries: ArchiveEntry[] = sessions
      .filter((session) => cwdGroupKey(session.cwd) === key)
      .map((session) => ({ sessionId: session.sessionId, displayName: session.displayName }));
    if (entries.length === 0) return;
    const result = archiveSessions(this.deps.metadataPath, entries);
    if (!result.ok) {
      this.postError(result.message);
    }
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
