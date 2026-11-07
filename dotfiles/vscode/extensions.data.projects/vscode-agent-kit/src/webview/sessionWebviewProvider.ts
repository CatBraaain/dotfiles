import * as vscode from "vscode";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import {
  activeSessionIds,
  archivedSessionNames,
  archiveSessions,
  hiddenWorkspaceCwds,
  legacyArchivedSessionNames,
  legacyRegisteredWorkspaceCwds,
  lockedSessionIds,
  migrateLegacyStore,
  readLegacyMetadataStore,
  readSessionStateStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  setSessionLocks,
  unarchiveSessions,
  unregisterWorkspace,
  type ArchiveEntry,
  type SessionRef,
  type SessionStateUpdateResult,
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
  /** Session state store (v2, shared with the pi extension). */
  statePath: string;
  /** v1 metadata store, only read for the one-time migration. */
  legacyMetadataPath: string;
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
   * files, then send display-only data to the webview. Inactive sessions
   * with a display-name snapshot skip reading their session file's body. */
  async refresh(): Promise<void> {
    await this.migrateLegacyStoreIfNeeded();

    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") {
      this.postError(store.message);
      return;
    }
    const data = store.status === "ok" ? store.data : undefined;
    const activeIds = activeSessionIds(data);
    const lockedIds = lockedSessionIds(data);
    const snapshotNames = archivedSessionNames(data);
    const stateCwds = registeredWorkspaceCwds(data);
    const hiddenCwds = hiddenWorkspaceCwds(data);

    let sessions: SessionSummary[];
    try {
      sessions = await listSessions(this.deps.sessionDir, {
        cwds: stateCwds,
        archivedNames: snapshotNames,
      });
    } catch (error) {
      this.postError(`Failed to read Pi sessions: ${errorMessage(error)}`);
      return;
    }

    // Whitelist semantics: a scanned session the active lists do not mention
    // is inactive (archived) and only visible in the All view.
    const archivedIds = new Set(
      sessions.map((session) => session.sessionId).filter((id) => !activeIds.has(id)),
    );
    this.sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
    this.post({
      type: "sessions",
      state: {
        groups: sessionViewGroups(sessions, {
          registeredCwds: stateCwds,
          hiddenWorkspaceCwds: hiddenCwds,
          archivedIds,
          lockedIds,
        }),
        displayedSessionId: this.deps.registry.displayedSessionId,
      },
    });
  }

  /** One-time migration of the v1 metadata store into the session state
   * store. Best effort: a failed migration surfaces an error but never blocks
   * the list; the marker in the migrated store keeps it one-shot. */
  private async migrateLegacyStoreIfNeeded(): Promise<void> {
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") return;
    if (store.status === "ok" && store.data["migrated-v1"] === true) return;
    const legacy = readLegacyMetadataStore(this.deps.legacyMetadataPath);
    if (legacy.status !== "ok") return;

    const legacyData = legacy.data;
    const cwds = legacyRegisteredWorkspaceCwds(legacyData);
    const archivedNames = legacyArchivedSessionNames(legacyData);
    let summaries: SessionSummary[];
    try {
      summaries = await listSessions(this.deps.sessionDir, { cwds, archivedNames });
    } catch (error) {
      this.postError(
        `Failed to scan sessions for the ${basename(this.deps.legacyMetadataPath)} migration: ${errorMessage(error)}`,
      );
      return;
    }
    const result = migrateLegacyStore(this.deps.statePath, legacyData, summaries);
    if (!result.ok) {
      this.postError(result.message);
    }
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
      await this.updateKnownSession(request.sessionId, (ref) =>
        setSessionLocks(this.deps.statePath, [{ ...ref, locked: request.locked }]),
      );
      return;
    }
    if (request.type === "archiveSession") {
      // Archive snapshots the session's current display name from the scanned
      // summary before the store update runs.
      await this.updateKnownSession(request.sessionId, ({ sessionId, cwd }) =>
        archiveSessions(this.deps.statePath, [
          {
            sessionId,
            cwd,
            displayName: this.sessionsById.get(sessionId)?.displayName ?? "Untitled",
          },
        ]),
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

  /** Register a workspace folder in the session state store, then show the
   * list. Invalid paths answer with an error and leave the store unchanged; a
   * cwd already registered only closes the webview's form (via the refreshed
   * list message). A new registration archives the workspace's existing
   * sessions (with a display-name snapshot each) so the list starts clean and
   * future scans skip their bodies. */
  private async addWorkspace(path: string): Promise<void> {
    let directory: string;
    try {
      directory = await requireWorkDirectory(expandWorkDirectoryInput(path));
    } catch (error) {
      this.postError(`Invalid workspace path: ${errorMessage(error)}`);
      return;
    }
    const store = readSessionStateStore(this.deps.statePath);
    if (store.status === "error") {
      this.postError(store.message);
      return;
    }
    const alreadyListed = registeredWorkspaceCwds(
      store.status === "ok" ? store.data : undefined,
    ).includes(directory);
    if (!alreadyListed) {
      const result = registerWorkspace(this.deps.statePath, directory);
      if (!result.ok) {
        this.postError(result.message);
        return;
      }
      await this.archiveExistingSessions(directory);
    }
    await this.refresh();
  }

  /** Archive every session whose header cwd belongs to the given workspace
   * cwd, snapshotting each display name in one store write. Scan or write
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
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        displayName: session.displayName,
      }));
    if (entries.length === 0) return;
    const result = archiveSessions(this.deps.statePath, entries);
    if (!result.ok) {
      this.postError(result.message);
    }
  }

  /** Drop the workspace registration. The webview asks for confirmation
   * before sending the request; the group disappears from the list (registered
   * workspaces are the whitelist) and a sessionless registration too. The
   * workspace entry and its membership lists stay on disk, so registering the
   * cwd again restores the previous groups. */
  private async unregisterWorkspace(cwd: string): Promise<void> {
    const result = unregisterWorkspace(this.deps.statePath, cwd);
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
