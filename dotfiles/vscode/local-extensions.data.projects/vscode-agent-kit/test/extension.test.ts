import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import manifest from "../package.json";
import { activate } from "../src/extension";
import { PiMux } from "../src/pi-mux";
import { SessionScmSelection } from "../src/session-scm";
import { SessionWebviewProvider } from "../src/webview/session-webview-provider";
import { cleanup, tempDir } from "./fixtures";

interface WatcherStub {
  base: { fsPath: string };
  pattern: string;
  onDidChange: Mock;
  onDidCreate: Mock;
  onDidDelete: Mock;
  dispose: Mock;
}

const api = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  onDidCloseTerminal: vi.fn(),
  onDidChangeActiveTerminal: vi.fn(
    (_listener: (terminal: vscode.Terminal | undefined) => void) => ({
      dispose: vi.fn(),
    }),
  ),
  activeTerminal: undefined as vscode.Terminal | undefined,
  executeCommand: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  createFileSystemWatcher: vi.fn(),
  createOutputChannel: vi.fn(),
  watchers: [] as WatcherStub[],
  // workspaceFolders-sync state: folders, the untitled transition, and the
  // recorded workspace edits and title writes.
  folders: [] as { uri: { fsPath: string }; name: string }[],
  workspaceFile: undefined as { scheme: string; fsPath: string } | undefined,
  added: [] as { path: string; name: string | undefined }[],
  removedPaths: [] as string[],
  titleUpdates: [] as { section: string; key: string; value: unknown; target: unknown }[],
  folderListeners: new Set<() => void>(),
  updateWorkspaceFolders: vi.fn(
    (
      start: number,
      deleteCount: number | undefined,
      ...toAdd: { uri: { fsPath: string }; name?: string }[]
    ) => {
      const removed = api.folders.splice(
        start,
        deleteCount ?? 0,
        ...toAdd.map((folder) => ({
          uri: folder.uri,
          name: folder.name ?? folder.uri.fsPath.split("/").pop()!,
        })),
      );
      api.added.push(...toAdd.map((folder) => ({ path: folder.uri.fsPath, name: folder.name })));
      api.removedPaths.push(...removed.map((folder) => folder.uri.fsPath));
      // Mirror VS Code: editing the folders of a single-folder window
      // (no workspace file yet) moves it to an untitled workspace.
      if (api.workspaceFile === undefined) {
        api.workspaceFile = { scheme: "untitled", fsPath: "/1555503116870" };
      }
      for (const listener of api.folderListeners) {
        listener();
      }
      return true;
    },
  ),
  onDidChangeWorkspaceFolders: vi.fn((listener: () => void) => {
    api.folderListeners.add(listener);
    return { dispose: () => api.folderListeners.delete(listener) };
  }),
  getConfiguration: vi.fn((section: string) => ({
    update: (key: string, value: unknown, target: unknown) => {
      api.titleUpdates.push({ section, key, value, target });
      return Promise.resolve();
    },
  })),
  tabGroups: { all: [] as never[], close: vi.fn(async () => true) },
}));

vi.mock("node:os", { spy: true });

vi.mock("../src/ticket-dispatch", () => ({
  registerTicketDispatch: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: { registerCommand: api.registerCommand, executeCommand: api.executeCommand },
  window: api,
  workspace: {
    createFileSystemWatcher: api.createFileSystemWatcher,
    get workspaceFolders() {
      return api.folders.length > 0 ? api.folders : undefined;
    },
    get workspaceFile() {
      return api.workspaceFile;
    },
    getConfiguration: api.getConfiguration,
    updateWorkspaceFolders: (
      start: number,
      deleteCount: number | undefined,
      ...toAdd: { uri: { fsPath: string }; name?: string }[]
    ) => api.updateWorkspaceFolders(start, deleteCount, ...toAdd),
    onDidChangeWorkspaceFolders: (listener: () => void) =>
      api.onDidChangeWorkspaceFolders(listener),
  },
  ConfigurationTarget: { Workspace: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
}));

let root: string;
const globalState = { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };

describe("extension commands", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    api.watchers = [];
    api.activeTerminal = undefined;
    api.folders = [];
    api.workspaceFile = undefined;
    api.added = [];
    api.removedPaths = [];
    api.titleUpdates = [];
    api.folderListeners = new Set();
    api.createFileSystemWatcher.mockImplementation(
      (pattern: { base: { fsPath: string }; pattern: string }) => {
        const watcher = {
          onDidChange: vi.fn(),
          onDidCreate: vi.fn(),
          onDidDelete: vi.fn(),
          dispose: vi.fn(),
        };
        api.watchers.push({ base: pattern.base, pattern: pattern.pattern, ...watcher });
        return watcher;
      },
    );
    api.registerCommand.mockReturnValue({ dispose: vi.fn() });
    api.onDidCloseTerminal.mockReturnValue({ dispose: vi.fn() });
    api.registerWebviewViewProvider.mockReturnValue({ dispose: vi.fn() });
    api.createOutputChannel.mockReturnValue({ dispose: vi.fn(), error: vi.fn() });
    vi.spyOn(SessionWebviewProvider.prototype, "refresh").mockResolvedValue();
    vi.stubEnv("PI_CODING_AGENT_DIR", "/fixture/agent");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "/fixture/sessions");
    root = await tempDir("pi-extension-test-");
    vi.mocked(os.homedir).mockReturnValue(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanup(root);
  });

  function watcherFor(directory: string): WatcherStub | undefined {
    return api.watchers.find(({ base }) => base.fsPath === directory);
  }

  function register(commandId = "agentKit.reloadAllPiSessions") {
    const disposable = { dispose: vi.fn() };
    api.registerCommand.mockReturnValue(disposable);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: join(root, "profile-storage") },
      globalState,
    } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(api.registerCommand).toHaveBeenCalledWith(commandId, expect.any(Function));
    expect(context.subscriptions).toContain(disposable);
    const registration = api.registerCommand.mock.calls.find(([id]) => id === commandId);
    if (registration === undefined) throw new Error(`Command not registered: ${commandId}`);
    return registration[1] as () => Promise<void>;
  }

  it("uses profile-wide storage for Session List workspaces and open times", async () => {
    const directory = join(root, "profile-storage");
    activate({
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: directory },
      globalState,
    } as unknown as vscode.ExtensionContext);
    const provider = api.registerWebviewViewProvider.mock.calls[0][1] as {
      deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
    };
    expect(provider.deps.sessionOpenState).toBe(globalState);
    await provider.deps.workspaceStore.add("/project");
    const files = await readdir(join(directory, "session-list-workspaces"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, "session-list-workspaces", files[0]), "utf8")).toBe(
      "/project",
    );
  });

  it("contributes the automatic SCM selection toggle to the command palette", () => {
    const commandId = "agentKit.toggleAutomaticScmSelection";
    expect(manifest.contributes.commands).toContainEqual({
      command: commandId,
      category: "Agent Kit",
      title: "Toggle Automatic SCM Selection",
    });
    expect(manifest.contributes.menus.commandPalette).not.toContainEqual(
      expect.objectContaining({ command: commandId }),
    );
  });

  it("connects the SCM palette command to the selection toggle", async () => {
    const toggle = vi.spyOn(SessionScmSelection.prototype, "toggle").mockResolvedValue();
    const runCommand = register("agentKit.toggleAutomaticScmSelection");
    await runCommand();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("does not register or contribute the removed tmux settings command", () => {
    register();
    expect(api.registerCommand.mock.calls.map(([id]) => id)).not.toContain(
      "agentKit.reapplyTmuxSettings",
    );
    expect(
      manifest.contributes.commands.some(
        ({ command }) => command === "agentKit.reapplyTmuxSettings",
      ),
    ).toBe(false);
  });

  it("initializes the Pi terminal context for an already active Agent Kit terminal", () => {
    api.activeTerminal = {
      creationOptions: { env: { PI_SESSIONS_DISPLAY: "1" } },
    } as unknown as vscode.Terminal;

    register();

    expect(api.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "agentKit.piTerminalActive",
      true,
    );
  });

  it("keeps the Pi terminal context in sync when the active terminal changes", () => {
    register();
    const [onChange] = api.onDidChangeActiveTerminal.mock.calls[0];
    onChange({
      creationOptions: { env: { PI_SESSIONS_DISPLAY: "1" } },
    } as unknown as vscode.Terminal);
    onChange({ creationOptions: { env: {} } } as vscode.Terminal);
    onChange(undefined);

    const terminalContextUpdates = api.executeCommand.mock.calls.filter(
      ([command, key]) => command === "setContext" && key === "agentKit.piTerminalActive",
    );
    expect(terminalContextUpdates.map(([, , value]) => value)).toEqual([false, true, false, false]);
  });

  it("forwards only the six arrow shortcuts while the Agent Kit terminal has focus", () => {
    const forwardArrowBindings = manifest.contributes.keybindings.filter(
      ({ key }) => key.endsWith("+up") || key.endsWith("+down"),
    );

    expect(forwardArrowBindings).toHaveLength(6);
    expect(
      Object.fromEntries(forwardArrowBindings.map(({ key, args }) => [key, args.text])),
    ).toEqual({
      "ctrl+up": "\u001b[1;5A",
      "ctrl+down": "\u001b[1;5B",
      "alt+up": "\u001b[1;3A",
      "alt+down": "\u001b[1;3B",
      "ctrl+shift+up": "\u001b[1;6A",
      "ctrl+shift+down": "\u001b[1;6B",
    });
    for (const binding of forwardArrowBindings) {
      expect(binding).toMatchObject({
        command: "workbench.action.terminal.sendSequence",
        when: "terminalFocus && agentKit.piTerminalActive",
      });
    }
  });

  it("starts list acquisition without a webview and watches only conversation files", async () => {
    const refresh = vi.spyOn(SessionWebviewProvider.prototype, "refresh").mockResolvedValue();
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    expect(api.createOutputChannel).toHaveBeenCalledWith("Agent Kit", { log: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect(api.watchers[0]).toMatchObject({
      base: { fsPath: "/fixture/sessions" },
      pattern: "**/*.jsonl",
    });
    expect(api.watchers[0].onDidDelete).toHaveBeenCalledOnce();
  });

  it("routes file creation, changes and deletion to history", async () => {
    const historyChanged = vi
      .spyOn(SessionWebviewProvider.prototype, "onSessionFileChanged")
      .mockResolvedValue();
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    for (const method of ["onDidCreate", "onDidChange", "onDidDelete"] as const) {
      const callback = api.watchers[0][method].mock.calls[0][0] as (uri: {
        fsPath: string;
      }) => void;
      callback({ fsPath: "/fixture/sessions/unregistered-or-deleted.jsonl" });
    }
    expect(historyChanged.mock.calls).toEqual([[], [], []]);
  });

  it("watches custom directories published by history or an unsaved Pi and releases removed workspaces", async () => {
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    const provider = api.registerWebviewViewProvider.mock.calls[0][1] as unknown as {
      deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
    };
    provider.deps.onSessionFiles!([
      { id: "A", cwd: "/project", file: "/custom/history/A.jsonl" },
      { id: "planned", cwd: "/project", file: "/custom/history/planned.jsonl" },
      { id: "B", cwd: "/project", file: "/fixture/sessions/group/B.jsonl" },
    ]);
    expect(api.watchers).toHaveLength(2);
    expect(watcherFor("/custom/history")).toBeDefined();
    provider.deps.onSessionFiles!([
      { id: "planned", cwd: "/project", file: "/custom/history/planned.jsonl" },
    ]);
    expect(api.watchers).toHaveLength(2);
    provider.deps.onSessionFiles!([]);
    expect(watcherFor("/custom/history")?.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, ".pi/agent"],
    ["", ".pi/agent"],
    ["~", "."],
    ["~/", "."],
    ["~/custom-agent", "custom-agent"],
    ["custom-agent", "host/custom-agent"],
    ["../custom-agent", "custom-agent"],
  ] as const)(
    "watches the default session root at startup for agent directory %s",
    async (input, directory) => {
      vi.spyOn(process, "cwd").mockReturnValue(join(root, "host"));
      vi.stubEnv("PI_CODING_AGENT_DIR", input);
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
      const agent = join(root, directory);
      const defaultSessions = join(agent, "sessions");
      const settingsPath = join(agent, "settings.json");
      await mkdir(agent, { recursive: true });
      await writeFile(settingsPath, "{}", "utf8");
      register();
      await vi.waitFor(() => expect(watcherFor(defaultSessions)).toBeDefined());
      expect(watcherFor(defaultSessions)?.pattern).toBe("**/*.jsonl");
      expect(api.watchers).toHaveLength(1);
    },
  );

  it.each(["absolute", "home-relative"])(
    "reads %s agent settings at startup and routes its conversation files to history",
    async (pathKind) => {
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
      const agent = join(root, "agent");
      const custom = join(root, "custom-history");
      await mkdir(agent, { recursive: true });
      await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: custom }), "utf8");
      vi.stubEnv("PI_CODING_AGENT_DIR", pathKind === "absolute" ? agent : "~/agent");
      const historyChanged = vi
        .spyOn(SessionWebviewProvider.prototype, "onSessionFileChanged")
        .mockResolvedValue();
      register();
      await vi.waitFor(() => expect(watcherFor(custom)).toBeDefined());
      expect(watcherFor(join(agent, "sessions"))).toBeUndefined();
      const created = watcherFor(custom)!.onDidCreate.mock.calls[0][0] as (uri: {
        fsPath: string;
      }) => void;
      created({ fsPath: join(custom, "new.jsonl") });
      expect(historyChanged).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("keeps the startup root until disposal and reads changed settings on reactivation", async () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const agent = join(root, "agent");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(agent, { recursive: true });
    const settingsPath = join(agent, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ sessionDir: first }), "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: join(root, "profile-storage") },
      globalState,
    } as unknown as vscode.ExtensionContext;
    activate(context);
    await vi.waitFor(() => expect(watcherFor(first)).toBeDefined());
    expect(api.watchers.map(({ pattern }) => pattern)).toEqual(["**/*.jsonl"]);

    await writeFile(settingsPath, JSON.stringify({ sessionDir: second }), "utf8");
    expect(watcherFor(second)).toBeUndefined();
    expect(watcherFor(first)?.dispose).not.toHaveBeenCalled();
    expect(api.watchers).toHaveLength(1);

    for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    expect(watcherFor(first)?.dispose).toHaveBeenCalledOnce();
    activate(context);
    await vi.waitFor(() => expect(watcherFor(second)).toBeDefined());
    expect(watcherFor(second)?.pattern).toBe("**/*.jsonl");
    expect(api.watchers).toHaveLength(2);
    for (const subscription of context.subscriptions) subscription.dispose();
  });

  it("shows reload in the Sessions toolbar without a refresh action", () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: "agentKit.reloadAllPiSessions",
      category: "Agent Kit",
      title: "Reload All Pi Sessions",
      icon: "$(debug-restart)",
    });
    expect(manifest.contributes.menus["view/title"]).toContainEqual({
      command: "agentKit.reloadAllPiSessions",
      when: "view == agentKit.sessions",
      group: "navigation@2",
    });
    expect(
      manifest.contributes.menus["view/title"].every(({ group }) =>
        group.startsWith("navigation@"),
      ),
    ).toBe(true);
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: "agentKit.reloadAllPiSessions",
      when: "false",
    });
    expect(manifest.contributes.commands.map(({ command }) => command)).not.toContain(
      "agentKit.refreshSessions",
    );
    expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe("Agent Kit");
    expect(manifest.contributes.views.agentKitViews[0].name).toBe("Sessions");
  });

  it("notifies and starts all-session reload without waiting for confirmation", async () => {
    const reloadAllSessions = vi.spyOn(PiMux.prototype, "reloadAllSessions").mockResolvedValue();
    const command = register("agentKit.reloadAllPiSessions");
    api.showInformationMessage.mockReturnValueOnce(new Promise(() => {}));

    await command();

    expect(api.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      "Reloading Pi sessions as they become idle.",
    );
    expect(api.showInformationMessage).toHaveBeenCalledBefore(reloadAllSessions);
    expect(reloadAllSessions).toHaveBeenCalledExactlyOnceWith();
    expect(api.showErrorMessage).not.toHaveBeenCalled();
  });

  it("notifies the user when all-session reload fails", async () => {
    vi.spyOn(PiMux.prototype, "reloadAllSessions").mockRejectedValue(new Error("reload denied"));
    const command = register("agentKit.reloadAllPiSessions");

    await command();

    expect(api.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      "Could not reload all Pi sessions: reload denied",
    );
  });

  // SPEC workspaceFolders 同期: verify the real activate() wiring from the
  // vscode adapter down to the sync engine, with git running for real in a
  // temporary repository.
  it("promotes the agents workspace folder, writes the title, and syncs worktree folders", async () => {
    const execFile = promisify(execFileCallback);
    const repository = join(root, "main");
    const worktree = join(root, "feat-x");
    await execFile("git", ["init", "-q", repository]);
    await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", repository, "config", "user.name", "test"]);
    await execFile("git", ["-C", repository, "commit", "--allow-empty", "-q", "-m", "init"]);
    await execFile("git", ["-C", repository, "worktree", "add", "-q", "-b", "feat-x", worktree]);

    const agents = join(root, ".agents", "workspace");
    api.folders = [{ uri: { fsPath: agents }, name: "workspace" }];
    const subscriptions: { dispose(): void }[] = [];
    activate({
      subscriptions,
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: join(root, "profile-storage") },
      globalState,
    } as unknown as vscode.ExtensionContext);

    try {
      // The startup transition re-applies folder 0 and moves the window to
      // an untitled workspace, where the fixed title template is written.
      await vi.waitFor(() => expect(api.added).toEqual([{ path: agents, name: "workspace" }]), {
        timeout: 5000,
      });
      expect(api.titleUpdates).toEqual([
        {
          section: "window",
          key: "title",
          value: "${dirty}${activeEditorShort}${separator}${profileName}${separator}${appName}",
          target: 2,
        },
      ]);

      // A pi-mux list push through the provider wiring adds the repository
      // cwd, and the detected worktree folder follows after the first
      // 2500 ms detection with the branch name.
      const provider = api.registerWebviewViewProvider.mock.calls[0][1] as unknown as {
        deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
      };
      provider.deps.onWorkspaces!([repository]);
      await vi.waitFor(
        () =>
          // The ordered application replaces folder 1 and beyond, so the
          // repository folder is re-added with its existing name together
          // with the detected worktree folder.
          expect(api.added).toEqual([
            { path: agents, name: "workspace" },
            { path: repository, name: undefined },
            { path: repository, name: "main" },
            { path: worktree, name: "feat-x" },
          ]),
        { timeout: 5000 },
      );
      expect(api.removedPaths).toEqual([agents, repository]);
    } finally {
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
    }
  });
});
