import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import manifest from "../package.json";
import { activate } from "../src/extension";
import { EmptySessionPool } from "../src/emptySessionPool";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
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

vi.mock("vscode", () => ({
  commands: { registerCommand: api.registerCommand },
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

describe("extension commands", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    api.watchers = [];
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
    api.createOutputChannel.mockReturnValue({ dispose: vi.fn() });
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

  function register(commandId = "agentKit.refreshSessions") {
    const disposable = { dispose: vi.fn() };
    api.registerCommand.mockReturnValue(disposable);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: join(root, "profile-storage") },
    } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(api.registerCommand).toHaveBeenCalledWith(commandId, expect.any(Function));
    expect(context.subscriptions).toContain(disposable);
    const registration = api.registerCommand.mock.calls.find(([id]) => id === commandId);
    if (registration === undefined) throw new Error(`Command not registered: ${commandId}`);
    return registration[1] as () => Promise<void>;
  }

  it("uses profile-wide storage files for the Sessions provider", async () => {
    const directory = join(root, "profile-storage");
    activate({
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: directory },
    } as unknown as vscode.ExtensionContext);
    const provider = api.registerWebviewViewProvider.mock.calls[0][1] as {
      deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
    };
    await provider.deps.workspaceStore.add("/project");
    const files = await readdir(join(directory, "session-list-workspaces"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, "session-list-workspaces", files[0]), "utf8")).toBe(
      "/project",
    );
  });

  it("does not register or contribute the removed tmux settings command", () => {
    register();
    expect(api.registerCommand.mock.calls.map(([id]) => id)).toEqual(["agentKit.refreshSessions"]);
    expect(
      manifest.contributes.commands.some(
        ({ command }) => command === "agentKit.reapplyTmuxSettings",
      ),
    ).toBe(false);
  });

  it("starts list acquisition without a webview and watches only conversation files", async () => {
    const sync = vi
      .spyOn(EmptySessionPool.prototype, "syncWorkspaces")
      .mockImplementation(() => {});
    const refresh = vi.spyOn(SessionWebviewProvider.prototype, "refresh").mockResolvedValue();
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    expect(api.createOutputChannel).toHaveBeenCalledWith("Agent Kit", { log: true });
    expect(sync).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(api.watchers[0]).toMatchObject({
      base: { fsPath: "/fixture/sessions" },
      pattern: "**/*.jsonl",
    });
    expect(api.watchers[0].onDidDelete).toHaveBeenCalledOnce();
  });

  it("observes session file creation and changes without relying on state or Refresh", async () => {
    vi.spyOn(EmptySessionPool.prototype, "syncWorkspaces").mockImplementation(() => {});
    const changed = vi
      .spyOn(EmptySessionPool.prototype, "onSessionFileChanged")
      .mockImplementation(() => {});
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    for (const method of ["onDidCreate", "onDidChange"] as const) {
      const callback = api.watchers[0][method].mock.calls[0][0] as (uri: {
        fsPath: string;
      }) => void;
      callback({ fsPath: "/fixture/sessions/first.jsonl" });
    }
    expect(changed.mock.calls).toEqual([
      ["/fixture/sessions/first.jsonl"],
      ["/fixture/sessions/first.jsonl"],
    ]);
  });

  it("routes file creation, changes and deletion to history without changing prewarm deletion handling", async () => {
    const historyChanged = vi
      .spyOn(SessionWebviewProvider.prototype, "onSessionFileChanged")
      .mockResolvedValue();
    const prewarmChanged = vi
      .spyOn(EmptySessionPool.prototype, "onSessionFileChanged")
      .mockImplementation(() => {});
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    for (const method of ["onDidCreate", "onDidChange", "onDidDelete"] as const) {
      const callback = api.watchers[0][method].mock.calls[0][0] as (uri: {
        fsPath: string;
      }) => void;
      callback({ fsPath: "/fixture/sessions/unregistered-or-deleted.jsonl" });
    }
    expect(historyChanged.mock.calls).toEqual([[], [], []]);
    expect(prewarmChanged.mock.calls).toEqual([
      ["/fixture/sessions/unregistered-or-deleted.jsonl"],
      ["/fixture/sessions/unregistered-or-deleted.jsonl"],
    ]);
  });

  it("watches custom directories published by history or an unsaved Pi and releases removed workspaces", async () => {
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    const provider = api.registerWebviewViewProvider.mock.calls[0][1] as unknown as {
      deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
    };
    provider.deps.onSessionFiles!([
      { cwd: "/project", file: "/custom/history/A.jsonl" },
      { cwd: "/project", file: "/custom/history/planned.jsonl" },
      { cwd: "/project", file: "/fixture/sessions/group/B.jsonl" },
    ]);
    expect(api.watchers).toHaveLength(2);
    expect(watcherFor("/custom/history")).toBeDefined();
    provider.deps.onSessionFiles!([{ cwd: "/project", file: "/custom/history/planned.jsonl" }]);
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
      vi.spyOn(EmptySessionPool.prototype, "onSessionFileChanged").mockImplementation(() => {});
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
    } as unknown as vscode.ExtensionContext;
    api.registerCommand.mockReturnValue({ dispose: vi.fn() });
    api.onDidCloseTerminal.mockReturnValue({ dispose: vi.fn() });
    api.registerWebviewViewProvider.mockReturnValue({ dispose: vi.fn() });
    vi.spyOn(SessionWebviewProvider.prototype, "refreshManually").mockResolvedValue();
    activate(context);
    await vi.waitFor(() => expect(watcherFor(first)).toBeDefined());
    expect(api.watchers.map(({ pattern }) => pattern)).toEqual(["**/*.jsonl"]);

    await writeFile(settingsPath, JSON.stringify({ sessionDir: second }), "utf8");
    const refresh = api.registerCommand.mock.calls[0][1] as () => Promise<void>;
    await refresh();
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

  it("contributes a named refresh icon only to the Sessions view title", () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: "agentKit.refreshSessions",
      category: "Agent Kit",
      title: "Refresh Sessions",
      icon: "$(refresh)",
    });
    expect(manifest.contributes.menus).toEqual({
      "view/title": [
        {
          command: "agentKit.refreshSessions",
          when: "view == agentKit.sessions",
          group: "navigation",
        },
      ],
      commandPalette: [{ command: "agentKit.refreshSessions", when: "false" }],
    });
    expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe("Agent Kit");
    expect(manifest.contributes.views.agentKitViews[0].name).toBe("Sessions");
  });

  it("refreshes the registered Sessions provider manually from the native title command", async () => {
    const refreshManually = vi
      .spyOn(SessionWebviewProvider.prototype, "refreshManually")
      .mockResolvedValue();
    const command = register("agentKit.refreshSessions");
    const provider = api.registerWebviewViewProvider.mock.calls[0][1];
    refreshManually.mockClear();

    await command();

    expect(refreshManually).toHaveBeenCalledOnce();
    expect(refreshManually.mock.instances[0]).toBe(provider);
    expect(api.showInformationMessage).not.toHaveBeenCalled();
    expect(api.showErrorMessage).not.toHaveBeenCalled();
  });

  // SPEC workspaceFolders 同期: verify the real activate() wiring from the
  // vscode adapter down to the sync engine, with git running for real in a
  // temporary repository.
  it("promotes the agents workspace folder, writes the title, and syncs worktree folders", async () => {
    vi.spyOn(EmptySessionPool.prototype, "syncWorkspaces").mockImplementation(() => {});
    const execFile = promisify(execFileCallback);
    const repository = join(root, "main");
    const worktree = join(root, "feat-x");
    await execFile("git", ["init", "-q", repository]);
    await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", repository, "config", "user.name", "test"]);
    await execFile("git", ["-C", repository, "commit", "--allow-empty", "-q", "-m", "init"]);
    await execFile("git", ["-C", repository, "worktree", "add", "-q", "-b", "feat-x", worktree]);

    const agents = join(root, ".agents", "agents-workspace");
    api.folders = [{ uri: { fsPath: agents }, name: "agents-workspace" }];
    const subscriptions: { dispose(): void }[] = [];
    activate({
      subscriptions,
      extensionUri: { fsPath: "/extension" },
      globalStorageUri: { fsPath: join(root, "profile-storage") },
    } as unknown as vscode.ExtensionContext);

    try {
      // The startup transition re-applies folder 0 and moves the window to
      // an untitled workspace, where the fixed title template is written.
      await vi.waitFor(
        () => expect(api.added).toEqual([{ path: agents, name: "agents-workspace" }]),
        { timeout: 5000 },
      );
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
          expect(api.added).toEqual([
            { path: agents, name: "agents-workspace" },
            { path: repository, name: undefined },
            { path: worktree, name: "feat-x" },
          ]),
        { timeout: 5000 },
      );
      expect(api.removedPaths).toEqual([agents]);
    } finally {
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
    }
  });
});
