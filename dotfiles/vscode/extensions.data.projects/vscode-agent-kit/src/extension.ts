import * as vscode from "vscode";
import { homedir } from "node:os";
import { metadataStorePath, resolveAgentDir, resolveSessionDir } from "./paths";
import { setSessionActive } from "./metadataStore";
import { SessionLauncher } from "./launcher";
import { SessionTreeProvider, sessionIdFromCommandArg, VIEW_ID, type SessionTreeElement, type ViewMode } from "./treeData";
import { createSessionTerminal } from "./terminals";
import { TerminalRegistry } from "./terminalRegistry";

/** View mode ("active" | "all") persisted in globalState so it survives restarts. */
class ViewModeState implements vscode.Disposable {
  private static readonly STORAGE_KEY = "piSessions.viewMode";
  private readonly context: vscode.ExtensionContext;
  private readonly onChanged: () => void;
  private modeValue: ViewMode;

  constructor(context: vscode.ExtensionContext, onChanged: () => void) {
    this.context = context;
    this.onChanged = onChanged;
    this.modeValue = context.globalState.get<string>(ViewModeState.STORAGE_KEY) === "all" ? "all" : "active";
    this.applyContext();
  }

  get mode(): ViewMode {
    return this.modeValue;
  }

  set(mode: ViewMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    void this.context.globalState.update(ViewModeState.STORAGE_KEY, mode);
    this.applyContext();
    this.onChanged();
  }

  private applyContext(): void {
    void vscode.commands.executeCommand("setContext", "piSessions.mode", this.modeValue);
  }

  dispose(): void {
    // nothing to clean up
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const agentDir = resolveAgentDir(process.env, homeDir);
  const sessionDir = resolveSessionDir(process.env, homeDir);
  const metadataPath = metadataStorePath(agentDir);

  const registry = new TerminalRegistry();
  context.subscriptions.push(vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)));

  const provider = new SessionTreeProvider({ sessionDir, metadataPath, getMode: () => modeState.mode });
  const modeState = new ViewModeState(context, () => void provider.refresh());
  const treeView = vscode.window.createTreeView<SessionTreeElement>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.attachView(treeView);

  const launcher = new SessionLauncher({
    sessionDir,
    metadataPath,
    registry,
    onSessionDetected: () => provider.refresh(),
  });

  context.subscriptions.push(treeView, provider, modeState, launcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("piSessions.openSession", (arg: unknown) => {
      const sessionId = sessionIdFromCommandArg(arg);
      if (sessionId !== undefined) void openSession(provider, registry, metadataPath, sessionId);
    }),
    vscode.commands.registerCommand("piSessions.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("piSessions.deactivate", (arg: unknown) => {
      const sessionId = sessionIdFromCommandArg(arg);
      if (sessionId === undefined) return;
      const result = setSessionActive(metadataPath, sessionId, false);
      if (!result.ok) {
        // Write failed: show the error and leave the view unchanged.
        void vscode.window.showErrorMessage(result.message);
        return;
      }
      void provider.refresh();
    }),
    vscode.commands.registerCommand("piSessions.newSession", () => launcher.start()),
    vscode.commands.registerCommand("piSessions.showActiveMode", () => modeState.set("active")),
    vscode.commands.registerCommand("piSessions.showAllMode", () => modeState.set("all")),
  );

  void provider.refresh();
}

/**
 * Open a session's Pi TUI in an Editor Area terminal.
 * Reuses the live terminal when one exists; otherwise starts `pi --session`.
 * Opening a session also marks it active (so it appears in Active mode).
 */
async function openSession(
  provider: SessionTreeProvider,
  registry: TerminalRegistry,
  metadataPath: string,
  sessionId: string,
): Promise<void> {
  const session = provider.getSession(sessionId);
  if (session === undefined) {
    void vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
    return;
  }
  const existing = registry.get(sessionId);
  if (existing !== undefined) {
    existing.show();
  } else {
    const terminal = createSessionTerminal(session);
    registry.set(sessionId, terminal);
    terminal.show();
  }
  const result = setSessionActive(metadataPath, sessionId, true);
  if (!result.ok) {
    void vscode.window.showErrorMessage(result.message);
  }
  await provider.refresh();
}

export function deactivate(): void {
  // disposables registered on the extension context are cleaned up by VS Code
}
