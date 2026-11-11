import * as vscode from "vscode";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { SessionLauncher } from "./launcher";
import { resolveAgentDir, resolveSessionDir, sessionStatePath } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { editorTerminals } from "./terminals";
import { TmuxRuntimeStore, piMuxSocketPath } from "./tmux";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const agentDir = resolveAgentDir(process.env, homeDir);
  const sessionDir = resolveSessionDir(process.env, homeDir);
  const statePath = sessionStatePath(agentDir);
  const tmux = new TmuxRuntimeStore(piMuxSocketPath());
  const registry = new TerminalRegistry(tmux, editorTerminals(tmux));

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
  );

  const launcher: SessionLauncher = new SessionLauncher({
    statePath,
    registry,
    onSessionStarted: () => provider.refresh(),
  });
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    sessionDir,
    statePath,
    registry,
    startNewSession: (cwd) => launcher.start(cwd),
  });

  // The pi extension `session-state` rewrites the store on every sent
  // message and phase change; watching it keeps the list live.
  const stateWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dirname(statePath)), basename(statePath)),
  );
  stateWatcher.onDidChange(() => void provider.refresh());
  stateWatcher.onDidCreate(() => void provider.refresh());

  context.subscriptions.push(
    launcher,
    provider,
    stateWatcher,
    vscode.commands.registerCommand("piSessions.refreshSessions", () => provider.refresh()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
