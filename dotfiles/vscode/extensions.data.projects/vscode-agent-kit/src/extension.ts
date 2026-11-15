import * as vscode from "vscode";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { SessionLauncher } from "./launcher";
import { EmptySessionPool } from "./emptySessionPool";
import { resolveAgentDir, resolveConfiguredSessionRoot } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { editorTerminals } from "./terminals";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const agentDir = resolveAgentDir(process.env, homeDir);
  const registry = new TerminalRegistry(editorTerminals());
  const log = vscode.window.createOutputChannel("Pi Sessions", { log: true });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
    log,
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
    onSessionStarted: () => provider.refresh(false),
  });
  let sessionRoot: string | undefined;
  let rootWatcher: vscode.FileSystemWatcher | undefined;
  let applyingRoot: Promise<void> | undefined;
  const historyWatchers = new Map<string, vscode.FileSystemWatcher>();
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    registry,
    emptySessions,
    startNewSession: (cwd, onPresented) => launcher.start(cwd, onPresented),
    onWorkspaces: (cwds) => emptySessions.syncWorkspaces(cwds),
    onSessionFiles: (files) => {
      const directories = new Set(files.map(({ file }) => dirname(file)));
      for (const [directory, watcher] of historyWatchers) {
        if (directories.has(directory)) continue;
        watcher.dispose();
        historyWatchers.delete(directory);
      }
      for (const directory of directories) {
        if (sessionRoot !== undefined && isInsideDirectory(sessionRoot, directory)) continue;
        if (!historyWatchers.has(directory))
          historyWatchers.set(directory, watchDirectory(directory));
      }
    },
    log,
  });

  function watchDirectory(directory: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(directory), "**/*.jsonl"),
    );
    function changed(uri: vscode.Uri): void {
      emptySessions.onSessionFileChanged(uri.fsPath);
      void provider.onSessionFileChanged(uri.fsPath);
    }
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete((uri) => {
      void provider.onSessionFileChanged(uri.fsPath);
    });
    return watcher;
  }

  function isInsideDirectory(parent: string, directory: string): boolean {
    const fromParent = relative(parent, directory);
    return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
  }

  function applySessionRoot(): Promise<void> {
    const applied = (applyingRoot ?? Promise.resolve()).then(async () => {
      let root: string;
      try {
        root = await resolveConfiguredSessionRoot(process.env, homeDir, process.cwd());
      } catch {
        return;
      }
      if (root === sessionRoot) return;
      const switched = sessionRoot !== undefined;
      sessionRoot = root;
      rootWatcher?.dispose();
      for (const watcher of historyWatchers.values()) watcher.dispose();
      historyWatchers.clear();
      rootWatcher = watchDirectory(root);
      if (switched) void provider.onSessionRootChanged();
    });
    applyingRoot = applied;
    return applied;
  }

  const settingsWatchers: vscode.FileSystemWatcher[] = [];
  if (!process.env.PI_CODING_AGENT_SESSION_DIR) {
    for (const settingsPath of new Set([
      join(agentDir, "settings.json"),
      join(process.cwd(), ".pi", "settings.json"),
    ])) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dirname(settingsPath)), basename(settingsPath)),
      );
      const reapply = () => void applySessionRoot();
      watcher.onDidCreate(reapply);
      watcher.onDidChange(reapply);
      watcher.onDidDelete(reapply);
      settingsWatchers.push(watcher);
    }
  }
  void applySessionRoot();
  void provider.refresh();

  context.subscriptions.push(
    launcher,
    registry,
    emptySessions,
    provider,
    {
      dispose: () => {
        rootWatcher?.dispose();
        for (const watcher of historyWatchers.values()) watcher.dispose();
        for (const watcher of settingsWatchers) watcher.dispose();
      },
    },
    vscode.commands.registerCommand("piSessions.refreshSessions", () => provider.refreshManually()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
