import * as vscode from "vscode";
import { groupSessions, type SessionGroup } from "./grouping";
import { activeSessionIds, readMetadataStore } from "./metadataStore";
import { listSessions, type SessionSummary } from "./sessionStore";
import { errorMessage } from "./guards";
import { visibleSessions, type ViewMode } from "./viewMode";

export type { ViewMode };

export const VIEW_ID = "piSessions.sessions";

/** Tree elements: cwd groups at the root, sessions as their children. */
export type SessionTreeElement =
  | { kind: "group"; group: SessionGroup }
  | { kind: "session"; session: SessionSummary; isActive: boolean };

export interface SessionTreeDeps {
  sessionDir: string;
  metadataPath: string;
  getMode: () => ViewMode;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeElement>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<SessionTreeElement | undefined>();
  readonly onDidChangeTreeData = this.change.event;

  private groups: SessionGroup[] = [];
  private activeIds = new Set<string>();
  private sessionsById = new Map<string, SessionSummary>();
  private treeView: vscode.TreeView<SessionTreeElement> | undefined;

  constructor(private readonly deps: SessionTreeDeps) {}

  /** Attach the created TreeView so the provider can set the empty-state message. */
  attachView(treeView: vscode.TreeView<SessionTreeElement>): void {
    this.treeView = treeView;
    this.updateEmptyMessage();
  }

  dispose(): void {
    this.change.dispose();
  }

  /** Re-read the session directory and the metadata store, then redraw the tree. */
  async refresh(): Promise<void> {
    const problems: string[] = [];
    let sessions: SessionSummary[] = [];
    try {
      sessions = await listSessions(this.deps.sessionDir);
    } catch (error) {
      problems.push(`Failed to read Pi sessions: ${errorMessage(error)}`);
    }
    const metadata = readMetadataStore(this.deps.metadataPath);
    if (metadata.status === "error") {
      problems.push(metadata.message);
    }
    if (problems.length > 0) {
      void vscode.window.showErrorMessage(problems.join(" — "));
    }

    this.activeIds = metadata.status === "ok" ? activeSessionIds(metadata.data) : new Set<string>();
    this.groups = groupSessions(visibleSessions(sessions, this.deps.getMode(), this.activeIds));
    this.sessionsById = new Map(sessions.map((s) => [s.sessionId, s]));
    this.change.fire(undefined);
    this.updateEmptyMessage();
  }

  /** Look up a session from the most recent scan. */
  getSession(sessionId: string): SessionSummary | undefined {
    return this.sessionsById.get(sessionId);
  }

  getTreeItem(element: SessionTreeElement): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = element.group.cwd;
      item.contextValue = "piSessions.cwdGroup";
      return item;
    }
    const { session, isActive } = element;
    const updated = new Date(session.mtimeMs).toLocaleString();
    const item = new vscode.TreeItem(session.displayName);
    item.tooltip = `${session.displayName}\n${session.sessionId}\n${session.cwd}\nUpdated: ${updated}`;
    item.description = updated;
    item.iconPath = isActive
      ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("circle-outline");
    item.contextValue = isActive ? "piSession.active" : "piSession.inactive";
    item.command = {
      command: "piSessions.openSession",
      title: "Open Session",
      arguments: [session.sessionId],
    };
    return item;
  }

  getChildren(element?: SessionTreeElement): vscode.ProviderResult<SessionTreeElement[]> {
    if (element === undefined) {
      return this.groups.map((group) => ({ kind: "group" as const, group }));
    }
    if (element.kind === "group") {
      return element.group.sessions.map((session) => ({
        kind: "session" as const,
        session,
        isActive: this.activeIds.has(session.sessionId),
      }));
    }
    return [];
  }

  private updateEmptyMessage(): void {
    if (this.treeView === undefined) return;
    this.treeView.message =
      this.groups.length === 0 ? (this.deps.getMode() === "active" ? "No active sessions" : "No sessions") : undefined;
  }
}

/** Extract a session id from a command argument (tree element or raw id string). */
export function sessionIdFromCommandArg(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (typeof arg === "object" && arg !== null && "kind" in arg) {
    const element = arg as SessionTreeElement;
    if (element.kind === "session") return element.session.sessionId;
  }
  return undefined;
}
