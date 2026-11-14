import * as vscode from "vscode";
import { homedir } from "node:os";
import { SessionLauncher } from "./launcher";
import { EmptySessionPool } from "./emptySessionPool";
import { resolveSessionDir } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { editorTerminals } from "./terminals";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const sessionDir = resolveSessionDir(process.env, homeDir);
  const registry = new TerminalRegistry(editorTerminals());

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
  );

  const emptySessions = new EmptySessionPool({
    mux: registry.mux,
    onError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });
  const launcher: SessionLauncher = new SessionLauncher({
    registry,
    emptySessions,
    onSessionStarted: () => provider.refresh(),
  });
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    registry,
    emptySessions,
    startNewSession: (cwd) => launcher.start(cwd),
    onWorkspaces: (cwds) => emptySessions.syncWorkspaces(cwds),
  });

  const sessionWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(sessionDir), "**/*.jsonl"),
  );
  sessionWatcher.onDidCreate((uri) => emptySessions.onSessionFileChanged(uri.fsPath));
  sessionWatcher.onDidChange((uri) => emptySessions.onSessionFileChanged(uri.fsPath));
  void provider.refresh();

  context.subscriptions.push(
    launcher,
    registry,
    emptySessions,
    provider,
    sessionWatcher,
    vscode.commands.registerCommand("piSessions.refreshSessions", () => provider.refresh()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
