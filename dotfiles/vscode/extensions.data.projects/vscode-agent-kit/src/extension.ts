import * as vscode from "vscode";
import { homedir } from "node:os";
import { SessionLauncher } from "./launcher";
import { metadataStorePath, resolveAgentDir, resolveSessionDir } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const agentDir = resolveAgentDir(process.env, homeDir);
  const sessionDir = resolveSessionDir(process.env, homeDir);
  const metadataPath = metadataStorePath(agentDir);
  const registry = new TerminalRegistry();

  context.subscriptions.push(vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)));

  let startNewSession = (): Promise<void> => Promise.reject(new Error("Session launcher is not ready"));
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    sessionDir,
    metadataPath,
    registry,
    startNewSession: () => startNewSession(),
  });
  const launcher = new SessionLauncher({
    sessionDir,
    metadataPath,
    registry,
    onSessionDetected: () => provider.refresh(),
  });
  startNewSession = () => launcher.start();

  context.subscriptions.push(
    launcher,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
