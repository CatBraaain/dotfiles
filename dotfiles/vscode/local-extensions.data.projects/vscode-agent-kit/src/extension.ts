import * as vscode from "vscode";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { SessionLauncher } from "./launcher";
import { FolderSyncEngine, type VscodeLike } from "./folder-sync";
import { resolveConfiguredSessionRoot } from "./paths";
import { PiMux } from "./pi-mux";
import { SELECT_SCM_REPOSITORIES, SessionScmSelection } from "./session-scm";
import { TerminalRegistry } from "./terminal-registry";
import { editorTerminals, isDisplayTerminal } from "./terminals";
import { registerTicketDispatch } from "./ticket-dispatch";
import { errorMessage } from "./guards";
import { WorkspaceStore } from "./workspace-store";
import { SessionWebviewProvider, VIEW_ID } from "./webview/session-webview-provider";

const TICKET_DISPATCH_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFileCallback);

const execFile = async (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout?: number },
): Promise<{ stdout: string }> => {
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

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): { readonly repositories: readonly { rootUri: vscode.Uri }[] };
}

function detectedGitRoots(): string[] | undefined {
  const git = vscode.extensions?.getExtension<GitExtension>("vscode.git");
  if (!git?.isActive || !git.exports.enabled) return undefined;
  return git.exports
    .getAPI(1)
    .repositories.map(({ rootUri }) =>
      rootUri.scheme === "vscode-remote" && rootUri.authority.startsWith("wsl+")
        ? rootUri.path
        : rootUri.fsPath,
    );
}

export function activate(context: vscode.ExtensionContext): void {
  const homeDir = homedir();
  const log = vscode.window.createOutputChannel("Agent Kit", { log: true });
  const mux = new PiMux();
  const scm = new SessionScmSelection({
    sessionWorktrees: (sessionId, cwd) => mux.sessionWorktrees(sessionId, cwd),
    isSessionUnsaved: async (sessionId) =>
      (await mux.list()).some(({ empty }) => empty.some(({ id }) => id === sessionId)),
    execFile,
    detectedRoots: detectedGitRoots,
    selectRepositories: (paths) => vscode.commands.executeCommand(SELECT_SCM_REPOSITORIES, paths),
    log: (message) => log.error(message),
  });
  const registry = new TerminalRegistry(editorTerminals(), mux, (session) => scm.track(session));

  function updateActiveTerminalContext(terminal: vscode.Terminal | undefined): void {
    void Promise.resolve(
      vscode.commands.executeCommand(
        "setContext",
        "agentKit.piTerminalActive",
        isDisplayTerminal(terminal),
      ),
    ).catch((error: unknown) => log.error("Could not update the Pi terminal context", error));
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => registry.onTerminalClosed(closed)),
    vscode.window.onDidChangeActiveTerminal(updateActiveTerminalContext),
    log,
  );
  updateActiveTerminalContext(vscode.window.activeTerminal);

  const folderSync = new FolderSyncEngine({
    vscode: folderSyncApi(),
    execFile,
    homeDir,
    onWorktreeDetection: () => void scm.refresh(),
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
    sessionOpenState: context.globalState,
    workspaceStore: new WorkspaceStore(
      join(context.globalStorageUri.fsPath, "session-list-workspaces"),
    ),
    registry,
    startNewSession: (cwd, onPresented) => launcher.start(cwd, onPresented),
    onWorkspaces: (cwds) => {
      folderSync.updateList(cwds);
    },
    onSessionFiles: (files) => {
      scm.updateSessionFiles(files);
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
      scm.onSessionFileChanged(uri.fsPath);
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

  registerTicketDispatch(
    context,
    (args) => execFile("ticket", args, { cwd: homeDir, timeout: TICKET_DISPATCH_TIMEOUT_MS }),
    log,
  );

  void initializeSessionRoot();
  void provider.refresh();

  context.subscriptions.push(
    launcher,
    registry,
    provider,
    {
      dispose: () => {
        disposed = true;
        scm.track(undefined);
        rootWatcher?.dispose();
        for (const watcher of historyWatchers.values()) watcher.dispose();
      },
    },
    vscode.commands.registerCommand("agentKit.toggleAutomaticScmSelection", () => scm.toggle()),
    vscode.commands.registerCommand("agentKit.reloadAllPiSessions", async () => {
      void vscode.window.showInformationMessage("Reloading Pi sessions as they become idle.");
      try {
        await registry.mux.reloadAllSessions();
      } catch (error) {
        const message = `Could not reload all Pi sessions: ${errorMessage(error)}`;
        log.error(message);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
