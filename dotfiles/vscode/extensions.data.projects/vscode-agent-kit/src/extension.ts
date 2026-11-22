import * as vscode from "vscode";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { SessionLauncher } from "./launcher";
import { FolderSyncEngine, type VscodeLike } from "./folderSync";
import type { ExecFile } from "./gitWorktrees";
import { resolveConfiguredSessionRoot } from "./paths";
import { TerminalRegistry } from "./terminalRegistry";
import { editorTerminals } from "./terminals";
import { WorkspaceStore } from "./workspaceStore";
import { SessionWebviewProvider, VIEW_ID } from "./webview/sessionWebviewProvider";

const execFileAsync = promisify(execFileCallback);

const execFile: ExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    ...options,
    windowsHide: true,
  });
  return { stdout };
};

/** Structural adapter from the real vscode API to the sync engine's VscodeLike. */
function folderSyncApi(): VscodeLike {
  return {
    workspace: {
      get workspaceFolders() {
        return vscode.workspace.workspaceFolders;
      },
      get workspaceFile() {
        return vscode.workspace.workspaceFile;
      },
      getConfiguration: (section) => vscode.workspace.getConfiguration(section),
      updateWorkspaceFolders: (start, deleteCount, ...folders) =>
        vscode.workspace.updateWorkspaceFolders(
          start,
          deleteCount,
          ...folders.map((folder) => ({
            uri: vscode.Uri.file(folder.uri.fsPath),
            name: folder.name,
          })),
        ),
      onDidChangeWorkspaceFolders: (listener) =>
        vscode.workspace.onDidChangeWorkspaceFolders(listener),
    },
    window: {
      tabGroups: {
        get all() {
          // The real Tab type is a wide union; the sync only reads
          // input.uri / input.modified, so the structural narrowing is safe.
          return vscode.window.tabGroups.all as unknown as VscodeLike["window"]["tabGroups"]["all"];
        },
        close: (tabs, preserveFocus) =>
          vscode.window.tabGroups.close(tabs as unknown as readonly vscode.Tab[], preserveFocus),
      },
    },
    openFolder: (folderPath: string) =>
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folderPath), {
        forceNewWindow: false,
      }),
    configurationTarget: vscode.ConfigurationTarget,
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const registry = new TerminalRegistry(editorTerminals());
  const log = vscode.window.createOutputChannel("Agent Kit", { log: true });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
    log,
  );

  const folderSync = new FolderSyncEngine({
    vscode: folderSyncApi(),
    execFile,
    homeDir,
  });
  context.subscriptions.push(folderSync.start());
  const launcher: SessionLauncher = new SessionLauncher({
    registry,
    onSessionStarted: () => provider.refresh(false),
  });
  let sessionRoot: string | undefined;
  let rootWatcher: vscode.FileSystemWatcher | undefined;
  let disposed = false;
  const historyWatchers = new Map<string, vscode.FileSystemWatcher>();
  const provider = new SessionWebviewProvider({
    extensionUri: context.extensionUri.fsPath,
    workspaceStore: new WorkspaceStore(
      join(context.globalStorageUri.fsPath, "session-list-workspaces"),
    ),
    registry,
    startNewSession: (cwd, onPresented) => launcher.start(cwd, onPresented),
    onWorkspaces: (cwds) => {
      folderSync.updateList(cwds);
    },
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
    function changed(): void {
      void provider.onSessionFileChanged();
    }
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete(changed);
    return watcher;
  }

  function isInsideDirectory(parent: string, directory: string): boolean {
    const fromParent = relative(parent, directory);
    return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
  }

  async function initializeSessionRoot(): Promise<void> {
    let root: string;
    try {
      root = await resolveConfiguredSessionRoot(process.env, homeDir, process.cwd());
    } catch {
      return;
    }
    if (disposed) return;
    sessionRoot = root;
    rootWatcher = watchDirectory(root);
    for (const [directory, watcher] of historyWatchers) {
      if (!isInsideDirectory(root, directory)) continue;
      watcher.dispose();
      historyWatchers.delete(directory);
    }
  }

  void initializeSessionRoot();
  void provider.refresh();

  context.subscriptions.push(
    launcher,
    registry,
    provider,
    {
      dispose: () => {
        disposed = true;
        rootWatcher?.dispose();
        for (const watcher of historyWatchers.values()) watcher.dispose();
      },
    },
    vscode.commands.registerCommand("agentKit.refreshSessions", () => provider.refreshManually()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
