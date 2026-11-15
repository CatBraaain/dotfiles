import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as vscode from "vscode";
import manifest from "../package.json";
import { activate } from "../src/extension";
import { EmptySessionPool } from "../src/emptySessionPool";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
import { cleanup, tempDir } from "./fixtures";
import { SessionHistory } from "../src/sessionHistory";
import { fakeRuntimes } from "./runtimeFixtures";

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
}));

vi.mock("vscode", () => ({
  commands: { registerCommand: api.registerCommand },
  window: api,
  workspace: { createFileSystemWatcher: api.createFileSystemWatcher },
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanup(root);
  });

  function watcherFor(directory: string): WatcherStub | undefined {
    return api.watchers.find(({ base }) => base.fsPath === directory);
  }

  function register(commandId = "piSessions.refreshSessions") {
    const disposable = { dispose: vi.fn() };
    api.registerCommand.mockReturnValue(disposable);
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: "/extension" },
    } as unknown as vscode.ExtensionContext;
    activate(context);
    expect(api.registerCommand).toHaveBeenCalledWith(commandId, expect.any(Function));
    expect(context.subscriptions).toContain(disposable);
    const registration = api.registerCommand.mock.calls.find(([id]) => id === commandId);
    if (registration === undefined) throw new Error(`Command not registered: ${commandId}`);
    return registration[1] as () => Promise<void>;
  }

  it("does not register or contribute the removed tmux settings command", () => {
    register();
    expect(api.registerCommand.mock.calls.map(([id]) => id)).toEqual([
      "piSessions.refreshSessions",
    ]);
    expect(
      manifest.contributes.commands.some(
        ({ command }) => command === "piSessions.reapplyTmuxSettings",
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
    expect(api.createOutputChannel).toHaveBeenCalledWith("Pi Sessions", { log: true });
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
    vi.spyOn(EmptySessionPool.prototype, "onSessionFileChanged").mockImplementation(() => {});
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    for (const method of ["onDidCreate", "onDidChange", "onDidDelete"] as const) {
      const callback = api.watchers[0][method].mock.calls[0][0] as (uri: {
        fsPath: string;
      }) => void;
      callback({ fsPath: "/fixture/sessions/A.jsonl" });
    }
    expect(historyChanged).toHaveBeenCalledTimes(3);
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

  it("releases a published custom watcher when successful history becomes empty", async () => {
    register();
    await vi.waitFor(() => expect(api.watchers).toHaveLength(1));
    const provider = api.registerWebviewViewProvider.mock.calls[0][1] as unknown as {
      deps: ConstructorParameters<typeof SessionWebviewProvider>[0];
    };
    const runtimes = fakeRuntimes();
    const entry = {
      id: "archived",
      cwd: "/project",
      file: "/custom/archived/session.jsonl",
      title: null,
      btime: 1,
      mtime: 2,
      size: 10,
    };
    runtimes.history.set(entry.id, entry);
    const history = new SessionHistory(runtimes.mux, vi.fn(), provider.deps.onSessionFiles!);
    try {
      history.sync([{ cwd: entry.cwd, sessions: [], empty: [] }]);
      await history.load(() => true);
      expect(watcherFor("/custom/archived")).toBeDefined();
      runtimes.history.clear();
      await history.fileChanged(entry.file);
      await history.load(() => true);
      expect(watcherFor("/custom/archived")?.dispose).toHaveBeenCalledOnce();
    } finally {
      history.dispose();
    }
  });

  it("watches a settings-configured session root and routes its files to history", async () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const agent = join(root, "agent");
    const custom = join(root, "custom-history");
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: custom }), "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
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
    expect(historyChanged).toHaveBeenCalledWith(join(custom, "new.jsonl"));
  });

  it("re-watches and drops held history when settings move the session root", async () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    const agent = join(root, "agent");
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(agent, { recursive: true });
    const settingsPath = join(agent, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ sessionDir: first }), "utf8");
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    const rootChanged = vi
      .spyOn(SessionWebviewProvider.prototype, "onSessionRootChanged")
      .mockResolvedValue();
    register();
    await vi.waitFor(() => expect(watcherFor(first)).toBeDefined());
    await writeFile(settingsPath, JSON.stringify({ sessionDir: second }), "utf8");
    const settingsChanged = watcherFor(agent)!.onDidChange.mock.calls[0][0] as (uri: {
      fsPath: string;
    }) => void;
    settingsChanged({ fsPath: settingsPath });
    await vi.waitFor(() => expect(watcherFor(second)).toBeDefined());
    expect(watcherFor(first)?.dispose).toHaveBeenCalledOnce();
    expect(rootChanged).toHaveBeenCalledOnce();
  });

  it("contributes a named refresh icon only to the Sessions view title", () => {
    expect(manifest.contributes.commands).toContainEqual({
      command: "piSessions.refreshSessions",
      category: "Pi Sessions",
      title: "Refresh Sessions",
      icon: "$(refresh)",
    });
    expect(manifest.contributes.menus).toEqual({
      "view/title": [
        {
          command: "piSessions.refreshSessions",
          when: "view == piSessions.sessions",
          group: "navigation",
        },
      ],
      commandPalette: [{ command: "piSessions.refreshSessions", when: "false" }],
    });
    expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe("Pi Sessions");
    expect(manifest.contributes.views.piSessionViews[0].name).toBe("Sessions");
  });

  it("refreshes the registered Sessions provider from the native title command", async () => {
    const refresh = vi.spyOn(SessionWebviewProvider.prototype, "refresh").mockResolvedValue();
    const command = register("piSessions.refreshSessions");
    const provider = api.registerWebviewViewProvider.mock.calls[0][1];
    refresh.mockClear();

    await command();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.instances[0]).toBe(provider);
    expect(api.showInformationMessage).not.toHaveBeenCalled();
    expect(api.showErrorMessage).not.toHaveBeenCalled();
  });
});
