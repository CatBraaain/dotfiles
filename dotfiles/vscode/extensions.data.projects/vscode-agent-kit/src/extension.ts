import * as vscode from "vscode";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { errorMessage } from "./guards";
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
    vscode.commands.registerCommand("piSessions.reapplyTmuxSettings", async () => {
      try {
        const count = await tmux.reapplySettings();
        void vscode.window.showInformationMessage(
          count === 0 ? "No tmux sessions to update." : "tmux settings reapplied.",
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to reapply tmux settings: ${errorMessage(error)}`,
        );
      }
    }),
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
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
