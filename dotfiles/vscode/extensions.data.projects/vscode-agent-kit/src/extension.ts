import * as vscode from "vscode";
import { homedir } from "node:os";
import { SessionLauncher } from "./launcher";
import { resolveAgentDir, resolveSessionDir, sessionStatePath } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { editorTerminals } from "./terminals";
import { TmuxRuntimeStore, tmuxSocketName } from "./tmux";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const agentDir = resolveAgentDir(process.env, homeDir);
  const sessionDir = resolveSessionDir(process.env, homeDir);
  const statePath = sessionStatePath(agentDir);
  const tmux = new TmuxRuntimeStore(tmuxSocketName(agentDir, sessionDir));
  const registry = new TerminalRegistry(tmux, editorTerminals(tmux));

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
  );

  const launcher: SessionLauncher = new SessionLauncher({
    sessionDir,
    statePath,
    registry,
    onSessionDetected: () => provider.refresh(),
  });
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    sessionDir,
    statePath,
    registry,
    startNewSession: (cwd) => launcher.start(cwd),
  });

  context.subscriptions.push(
    launcher,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
