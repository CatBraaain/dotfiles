import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { webviewAppMarkup } from "../../src/webview/webview-html";
import { SessionLauncher } from "../../src/launcher";
import { WorkspaceStore } from "../../src/workspace-store";
import { PiMux, type PiMuxHistoryEntry, type PiMuxWorkspace } from "../../src/pi-mux";
import { TerminalRegistry } from "../../src/terminal-registry";
import { editorTerminals } from "../../src/terminals";
import { fakeRuntimes } from "./runtime-fixtures";
import {
  LIST_REFRESH_INTERVAL_MS,
  SessionWebviewProvider,
} from "../../src/webview/session-webview-provider";
import * as sessionStore from "../../src/session-store";
import * as workDirectory from "../../src/work-directory";
import type { SessionPhase, WebviewState } from "../../src/webview/protocol";
import { sessionListView, type ElementDescriptor } from "../../src/webview/client";
import {
  cleanup,
  combinedHistoryOutput,
  header,
  messageEntry,
  tempDir,
  writeJsonl,
} from "./fixtures";
const vscodeMocks = vi.hoisted(() => ({
  terminals: [],
  state: { focused: false },
  createTerminal: vi.fn(),
  showErrorMessage: vi.fn(),
  clipboardWriteText: vi.fn(),
  executeCommand: vi.fn(),
  getWorkspaceFolder: vi.fn(),
  updateWorkspaceFolders: vi.fn(),
  showInformationMessage: vi.fn(),
  getExtension: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [uri.fsPath, ...parts].join("/"),
    }),
  },
  TerminalLocation: { Editor: 1 },
  env: { clipboard: { writeText: vscodeMocks.clipboardWriteText } },
  window: vscodeMocks,
  workspace: {
    getWorkspaceFolder: vscodeMocks.getWorkspaceFolder,
    updateWorkspaceFolders: vscodeMocks.updateWorkspaceFolders,
  },
  commands: { executeCommand: vscodeMocks.executeCommand },
  extensions: { getExtension: vscodeMocks.getExtension },
}));

const activeSessionId = "00000000-0000-4000-8000-000000000001";
const inactiveSessionId = "00000000-0000-4000-8000-000000000002";
const unknownSessionId = "00000000-0000-4000-8000-000000000099";
let root: string;
const providers: SessionWebviewProvider[] = [];
let sharedRuntimes: ReturnType<typeof providerRuntimes>;
let workspaceStorage: ReturnType<typeof createWorkspaceStorage>;
let sessionOpenState: ReturnType<typeof createSessionOpenState>;

function createSessionOpenState() {
  const saved = new Map<string, unknown>();
  return {
    saved,
    get: vi.fn((key: string) => saved.get(key)) as unknown as ConstructorParameters<
      typeof SessionWebviewProvider
    >[0]["sessionOpenState"]["get"],
    update: vi.fn(async (key: string, openedAtMs: unknown) => {
      saved.set(key, openedAtMs);
    }),
  };
}

function createWorkspaceStorage() {
  const cwds = new Set<string>();
  return {
    list: vi.fn(async () => new Set(cwds)),
    add: vi.fn(async (cwd: string) => {
      cwds.add(cwd);
    }),
    remove: vi.fn(async (cwd: string) => {
      cwds.delete(cwd);
    }),
  };
}

beforeEach(async () => {
  root = await tempDir("pi-webview-provider-test-");
  vi.resetAllMocks();
  sharedRuntimes = providerRuntimes();
  workspaceStorage = createWorkspaceStorage();
  sessionOpenState = createSessionOpenState();
  historySeedCount = 0;
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup(root);
});

function createView() {
  let receiveMessage: ((message: unknown) => Promise<void>) | undefined;
  let visibilityListener: (() => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const postMessage = vi.fn().mockResolvedValue(true);
  const view = {
    visible: true,
    onDidChangeVisibility: (listener: () => void) => {
      visibilityListener = listener;
      return { dispose: () => {} };
    },
    webview: {
      options: {},
      html: "",
      postMessage,
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => `vscode-webview://test${uri.fsPath}`,
      }),
      onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
        receiveMessage = listener;
        return { dispose: () => {} };
      },
    },
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => {} };
    },
  };
  return {
    view,
    postMessage,
    dispose: () => disposeListener?.(),
    setVisible: (visible: boolean) => {
      view.visible = visible;
      visibilityListener?.();
    },
    receive: async (message: unknown) => {
      if (receiveMessage === undefined) throw new Error("message listener was not registered");
      await receiveMessage(message);
    },
  };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function finishRefresh(provider: SessionWebviewProvider) {
  await (provider as unknown as { pendingRefresh?: Promise<void> }).pendingRefresh;
}

async function finishHistoryRefresh(provider: SessionWebviewProvider) {
  await (provider as unknown as { pendingHistoryRefresh?: Promise<void> }).pendingHistoryRefresh;
}

function loadingMessages(webview: { postMessage: Mock }) {
  return webview.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "loading");
}

async function tick(provider: SessionWebviewProvider, milliseconds = LIST_REFRESH_INTERVAL_MS) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await finishRefresh(provider);
}

function providerRuntimes() {
  const runtimes = fakeRuntimes();
  runtimes.workspaces.add(root);
  return runtimes;
}

function createRuntimeRegistry() {
  return {
    ...sharedRuntimes,
    registry: new TerminalRegistry(editorTerminals(), sharedRuntimes.mux),
  };
}

function createRegistry() {
  return createRuntimeRegistry().registry;
}

let historySeedCount = 0;

async function seedSavedSession(
  sessionId: string,
  cwd = root,
  options: { title?: string | null; runtimes?: ReturnType<typeof fakeRuntimes> } = {},
): Promise<string> {
  const runtimes = options.runtimes ?? sharedRuntimes;
  const filePath = join(root, "sessions", `${sessionId}.jsonl`);
  await mkdir(join(root, "sessions"), { recursive: true });
  const contents = `${JSON.stringify(header({ id: sessionId, cwd }))}\n`;
  await writeFile(filePath, contents, "utf8");
  runtimes.emptyIds.delete(sessionId);
  runtimes.files.set(sessionId, filePath);
  runtimes.history.set(sessionId, {
    id: sessionId,
    cwd,
    file: filePath,
    title: options.title ?? null,
    btime: 900_000,
    mtime: 1_000_000 - historySeedCount++,
    size: contents.length,
    source: "normal",
  });
  return filePath;
}

function mockTerminal(
  runtimes: ReturnType<typeof fakeRuntimes>,
  terminal: object,
  registry: TerminalRegistry,
  openCwd: string,
): void {
  const { mocks, client } = runtimes;
  let created = false;
  vscodeMocks.createTerminal.mockImplementation((options) => {
    if (options.shellArgs?.at(0) === "new") {
      void mocks.newSession(options.shellArgs.at(-1) as string).then((sessionId) => {
        client.attachedId = sessionId;
      });
    } else {
      const sessionId = options.shellArgs?.at(-1);
      if (typeof sessionId === "string") {
        mocks.open({
          sessionId,
          cwd: openCwd,
          ...(options.shellArgs.includes("--temporary") ? { temporary: true as const } : {}),
        });
      }
    }
    if (!created) {
      created = true;
      return terminal;
    }
    const next = { ...terminal, dispose: vi.fn(() => registry.onTerminalClosed(next as never)) };
    return next;
  });
}

function createProvider(
  deps: Partial<ConstructorParameters<typeof SessionWebviewProvider>[0]> = {},
) {
  const statePath = join(root, "session-state.json");
  if (!existsSync(statePath)) writeFileSync(statePath, "invalid legacy JSON sentinel");
  const provider = new SessionWebviewProvider({
    extensionUri: root,
    workspaceStore: workspaceStorage,
    sessionOpenState,
    registry: createRegistry(),
    startNewSession: async () => undefined,
    ...deps,
  } as ConstructorParameters<typeof SessionWebviewProvider>[0]);
  providers.push(provider);
  return { provider, statePath };
}

async function deactivateFixture(
  options: { log?: ConstructorParameters<typeof SessionWebviewProvider>[0]["log"] } = {},
) {
  const runtimes = providerRuntimes();
  const filePath = await seedSavedSession(activeSessionId, root, { runtimes });
  await seedSavedSession(inactiveSessionId, root, { runtimes });
  for (const id of [activeSessionId, inactiveSessionId]) {
    runtimes.live.set(id, { sessionId: id, cwd: root, target: `pi-${id}` });
    runtimes.files.set(id, join(root, "sessions", `${id}.jsonl`));
  }
  const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
  const terminal = {
    creationOptions: { cwd: root },
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(() => registry.onTerminalClosed(terminal as never)),
  };
  mockTerminal(runtimes, terminal, registry, root);
  const { provider, statePath } = createProvider({ registry, log: options.log });

  const webview = createView();
  provider.resolveWebviewView(webview.view as never);
  await provider.refresh();
  return { ...runtimes, registry, terminal, provider, statePath, webview, filePath };
}

async function unreadFixture(
  options: { log?: ConstructorParameters<typeof SessionWebviewProvider>[0]["log"] } = {},
) {
  const fixture = await deactivateFixture(options);
  for (const sessionId of [activeSessionId, inactiveSessionId]) {
    fixture.live.set(sessionId, { sessionId, cwd: root, target: `pi-${sessionId}` });
  }

  async function setPhase(
    phase: SessionPhase | undefined,
    sessionId = activeSessionId,
  ): Promise<void> {
    fixture.phases.set(sessionId, phase ?? null);
    await fixture.provider.refresh();
  }

  function markCompletion(atMs = Date.now(), aborted = false, sessionId = activeSessionId) {
    fixture.settlements.set(sessionId, { atMs, aborted });
    fixture.phases.set(sessionId, "waiting-user");
  }

  async function complete(atMs = Date.now(), aborted = false): Promise<void> {
    markCompletion(atMs, aborted);
    await fixture.provider.refresh(false);
  }

  function sentState(webview = fixture.webview): WebviewState {
    const message = webview.postMessage.mock.calls
      .map((call) => call[0])
      .reverse()
      .find((message) => message.type === "sessions") as
      | { type: string; state?: WebviewState }
      | undefined;
    if (message?.state === undefined) throw new Error("no session state was sent");
    return message.state;
  }

  function row(sessionId = activeSessionId) {
    const session = sentState()
      .groups.flatMap((group) => group.sessions)
      .find((item) => item.sessionId === sessionId);
    if (session === undefined) throw new Error(`session row missing: ${sessionId}`);
    return session;
  }

  function holdRuntimeQuery() {
    let release: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const list = fixture.mocks.list.getMockImplementation()!;
    fixture.mocks.list.mockImplementationOnce(async () => {
      const snapshot = await list();
      signalStarted!();
      await response;
      return snapshot;
    });
    function finish() {
      release!();
    }
    return { started, finish };
  }

  await setPhase("waiting-user");
  return { ...fixture, setPhase, markCompletion, complete, sentState, row, holdRuntimeQuery };
}

async function loadingFixture() {
  const runtimes = providerRuntimes();
  const { mux, mocks } = runtimes;
  await seedSavedSession(activeSessionId, root, { runtimes });
  const registry = new TerminalRegistry(editorTerminals(), mux);
  const { provider, statePath } = createProvider({ registry });

  const webview = createView();
  provider.resolveWebviewView(webview.view as never);
  await vi.waitFor(() =>
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
    }),
  );
  webview.postMessage.mockClear();
  mocks.list.mockClear();
  return { provider, statePath, webview, mocks };
}

describe("SessionWebviewProvider", () => {
  /** Fixture for inactive-display switching: both sessions listed, the
   * inactive one inactive, and a reusable display terminal for the cwd. */
  async function inactiveDisplayFixture(deps: Parameters<typeof createProvider>[0] = {}) {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    await seedSavedSession(inactiveSessionId, root, { runtimes });
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    for (const sessionId of [activeSessionId, inactiveSessionId]) {
      runtimes.live.set(sessionId, { sessionId, cwd: root, target: `pi-${sessionId}` });
    }
    const terminal = {
      creationOptions: { cwd: root },
      processId: Promise.resolve(123),
      show: vi.fn(),
      dispose: vi.fn(() => registry.onTerminalClosed(terminal as never)),
    };
    mockTerminal(runtimes, terminal, registry, root);
    const { provider, statePath } = createProvider({ registry, ...deps });
    runtimes.temporary.add(inactiveSessionId);

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    return { runtimes, registry, terminal, provider, statePath, webview };
  }
  async function selectionFixture() {
    const fixture = await deactivateFixture();
    await seedSavedSession(unknownSessionId, root, { runtimes: fixture });
    await fixture.provider.refresh();
    const shown: (string | undefined)[] = [];
    fixture.terminal.show.mockImplementation(() => {
      shown.push(fixture.registry.displayedSessionId);
    });
    vscodeMocks.createTerminal.mockImplementation((options) => {
      fixture.mocks.open({
        sessionId: options.shellArgs.at(-1),
        cwd: root,
        ...(options.shellArgs.includes("--temporary") ? { temporary: true as const } : {}),
      });
      const terminal = {
        ...fixture.terminal,
        dispose: vi.fn(() => fixture.registry.onTerminalClosed(terminal as never)),
      };
      return terminal;
    });
    return { ...fixture, shown };
  }

  function holdNextOpen(mocks: ReturnType<typeof fakeRuntimes>["mocks"]) {
    let finish!: () => void;
    let signalStarted!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const list = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementationOnce(async () => {
      signalStarted();
      await pending;
      return list();
    });
    return { started, finish };
  }

  it("sends unregistered sessions as active and inactive ones from metadata, then deactivates on request", async () => {
    const runtimes = providerRuntimes();
    const filePath = await seedSavedSession(activeSessionId, root, { runtimes });
    await seedSavedSession(inactiveSessionId, root, { runtimes });
    runtimes.live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    runtimes.files.set(activeSessionId, filePath);
    const { provider } = createProvider({
      registry: new TerminalRegistry(editorTerminals(), runtimes.mux),
    });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const sentSessions = () =>
      webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions as {
        sessionId: string;
        isInactive: boolean;
      }[];
    expect(
      sentSessions()
        .map((session) => [session.sessionId, session.isInactive])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ).toEqual([
      [activeSessionId, false],
      [inactiveSessionId, true],
    ]);

    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });

    expect(
      sentSessions().find((session) => session.sessionId === activeSessionId)?.isInactive,
    ).toBe(true);
  });

  it("keeps the temporary collection and current Pi when list acquisition fails", async () => {
    const { runtimes, webview, provider, registry } = await inactiveDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const before = webview.postMessage.mock.calls
      .filter(([message]) => message.type === "sessions")
      .at(-1)?.[0].state;
    runtimes.mocks.list.mockRejectedValue(new Error("list failed"));
    await provider.refresh();
    expect(
      webview.postMessage.mock.calls.filter(([message]) => message.type === "sessions").at(-1)?.[0]
        .state,
    ).toEqual(before);
    expect(registry.displayedSessionId).toBe(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
  });

  describe("automatic list refresh", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));

    it("does not acquire history for an empty workspace registry", async () => {
      const runtime = providerRuntimes();
      runtime.workspaces.clear();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      expect(runtime.mocks.history).not.toHaveBeenCalled();
      expect(webview.postMessage.mock.lastCall?.[0].state.groups).toEqual([]);
    });

    it("skips unchanged display projections while continuing to poll with 1500 saved sessions", async () => {
      const { provider, mocks, history, webview, sentState } = await unreadFixture();
      const saved = history.get(activeSessionId)!;
      for (let index = history.size; index < 1500; index++) {
        const id = `saved-${index}`;
        history.set(id, { ...saved, id, file: join(root, `${id}.jsonl`) });
      }
      await provider.refresh();
      const state = sentState();
      expect(state.groups.flatMap(({ sessions }) => sessions)).toHaveLength(1500);
      const project = vi.spyOn(sessionStore, "listSessionSnapshot");
      mocks.list.mockClear();
      mocks.history.mockClear();
      webview.postMessage.mockClear();

      for (let index = 0; index < 3; index++) await tick(provider);

      expect(mocks.list).toHaveBeenCalledTimes(3);
      expect(mocks.history).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
    });

    it("reprojects phase and unread changes once and then skips unchanged polls", async () => {
      const { provider, phases, markCompletion, row } = await unreadFixture();
      const project = vi.spyOn(sessionStore, "listSessionSnapshot");
      phases.set(activeSessionId, "running");
      await tick(provider);
      expect(row()).toMatchObject({ state: "running", hasUnread: false });
      expect(project).toHaveBeenCalledOnce();
      await tick(provider);
      expect(project).toHaveBeenCalledOnce();

      markCompletion();
      await tick(provider);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      expect(project).toHaveBeenCalledTimes(2);
      await tick(provider);
      expect(project).toHaveBeenCalledTimes(2);
    });

    it("publishes a changed display selection even when list and history are unchanged", async () => {
      const { provider, registry, sentState } = await unreadFixture();
      vi.spyOn(registry, "displayedSessionId", "get").mockReturnValue(activeSessionId);
      await tick(provider);
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      const project = vi.spyOn(sessionStore, "listSessionSnapshot");
      await tick(provider);
      expect(project).not.toHaveBeenCalled();
    });

    it("keeps an acknowledged completion read across unchanged polls", async () => {
      const { provider, webview, markCompletion, row } = await unreadFixture();
      markCompletion();
      await tick(provider);
      expect(row().hasUnread).toBe(true);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(row().hasUnread).toBe(false);
      const project = vi.spyOn(sessionStore, "listSessionSnapshot");
      await tick(provider);
      expect(row().hasUnread).toBe(false);
      expect(project).not.toHaveBeenCalled();
    });

    it.each(["idle", "pending", "failed", "hidden"] as const)(
      "drops a stopped physical archive while history is %s without restoring it from stale history",
      async (historyStatus) => {
        const ordinaryFile = join(root, "normal.jsonl");
        const archiveFile = await writeJsonl(join(root, "archive"), "archived.jsonl", [
          header({ id: activeSessionId, cwd: root }),
        ]);
        const original = await readFile(archiveFile, "utf8");
        const entries: PiMuxHistoryEntry[] = [
          {
            id: inactiveSessionId,
            file: ordinaryFile,
            cwd: root,
            title: "Offline",
            btime: 50,
            mtime: 150,
            size: 10,
            source: "normal",
          },
          {
            id: activeSessionId,
            file: archiveFile,
            cwd: root,
            title: "Physical archive",
            btime: 100,
            mtime: 200,
            size: 20,
            source: "live-archive",
          },
        ];
        const combined = combinedHistoryOutput(root, entries);
        const held = deferred<string>();
        let isRunning = true;
        let shouldHoldHistory = false;
        let shouldFailActive = false;
        const execute = vi.fn(async (_executable: string, args: string[]) => {
          if (args.join(" ") === "list --json") return shouldHoldHistory ? held.promise : combined;
          if (args.join(" ") !== "list --active --json")
            throw new Error(`Unexpected command: ${args.join(" ")}`);
          if (shouldFailActive) throw new Error("Active unavailable");
          const sessions = isRunning
            ? [
                {
                  id: activeSessionId,
                  file: archiveFile,
                  state: null,
                  title: "",
                  temporary: true,
                  reloadStatus: "waiting-reload",
                },
              ]
            : [];
          return JSON.stringify([{ cwd: root, sessions, empty: [] }]);
        });
        const onSessionFiles = vi.fn();
        const { provider } = createProvider({
          registry: new TerminalRegistry(editorTerminals(), new PiMux(execute)),
          onSessionFiles,
        });
        const webview = createView();
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });
        function lastRows() {
          const state: WebviewState = webview.postMessage.mock.calls
            .map(([message]) => message.state)
            .filter(Boolean)
            .at(-1);
          return state.groups.flatMap(({ sessions }) => sessions);
        }
        expect(lastRows()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: inactiveSessionId,
              displayName: "Offline",
              isInactive: true,
            }),
            expect.objectContaining({
              sessionId: activeSessionId,
              displayName: "Physical archive",
              updatedAtMs: 200,
              isInactive: true,
              isLive: true,
              reloadPending: true,
            }),
          ]),
        );
        expect(onSessionFiles.mock.lastCall?.[0]).toEqual([
          { id: inactiveSessionId, file: ordinaryFile, isSaved: true },
          { id: activeSessionId, file: archiveFile, isSaved: true },
        ]);
        execute.mockClear();
        if (historyStatus !== "idle") {
          shouldHoldHistory = true;
          await provider.onSessionFileChanged();
        }
        if (historyStatus === "failed") {
          held.reject(new Error("History unavailable"));
          await finishHistoryRefresh(provider);
        }

        isRunning = false;
        if (historyStatus === "hidden") {
          webview.setVisible(false);
          await tick(provider, 1_000);
          expect(lastRows().map(({ sessionId }) => sessionId)).toContain(activeSessionId);
          webview.setVisible(true);
          await vi.advanceTimersByTimeAsync(0);
        } else {
          shouldFailActive = true;
          await tick(provider);
          expect(lastRows().map(({ sessionId }) => sessionId)).toContain(activeSessionId);
          shouldFailActive = false;
          await tick(provider);
        }
        expect(lastRows().map(({ sessionId }) => sessionId)).toEqual([inactiveSessionId]);
        expect(onSessionFiles.mock.lastCall?.[0]).toEqual([
          { id: inactiveSessionId, file: ordinaryFile, isSaved: true },
        ]);
        if (historyStatus === "failed") {
          expect(webview.postMessage.mock.lastCall?.[0]).toMatchObject({ type: "sessionsError" });
        }
        await webview.receive({ type: "copySessionId", sessionId: activeSessionId });
        expect(vscodeMocks.clipboardWriteText).not.toHaveBeenCalled();
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
          `Session not found: ${activeSessionId}`,
        );

        if (historyStatus === "pending" || historyStatus === "hidden") {
          held.resolve(combined);
          await finishHistoryRefresh(provider);
          expect(lastRows().map(({ sessionId }) => sessionId)).toEqual([inactiveSessionId]);
          expect(onSessionFiles.mock.lastCall?.[0]).toEqual([
            { id: inactiveSessionId, file: ordinaryFile, isSaved: true },
          ]);
        }
        expect(
          execute.mock.calls.filter(([, args]) => args.join(" ") === "list --json"),
        ).toHaveLength(historyStatus === "idle" ? 0 : 1);
        expect(await readFile(archiveFile, "utf8")).toBe(original);
      },
    );

    it.each(["offline", "replacement", "absent"] as const)(
      "reprojects a departed live file without archive metadata: %s",
      async (outcome) => {
        const runtimes = providerRuntimes();
        const ordinary = await seedSavedSession(activeSessionId, root, {
          title: "Ordinary",
          runtimes,
        });
        if (outcome === "absent") runtimes.history.delete(activeSessionId);
        await seedSavedSession(inactiveSessionId, root, { runtimes });
        const formerFile = join(root, "archive", "former.jsonl");
        for (const id of [activeSessionId, inactiveSessionId])
          runtimes.live.set(id, { sessionId: id, cwd: root, target: `pi-${id}` });
        runtimes.files.set(activeSessionId, formerFile);
        runtimes.titles.set(activeSessionId, "Departing live file");
        runtimes.phases.set(inactiveSessionId, "waiting-user");
        const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
        let displayedSessionId = activeSessionId;
        vi.spyOn(registry, "displayedSessionId", "get").mockImplementation(
          () => displayedSessionId,
        );
        const onSessionFiles = vi.fn();
        const { provider } = createProvider({ registry, onSessionFiles });
        const webview = createView();
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });

        runtimes.mocks.history.mockRejectedValueOnce(new Error("Unavailable"));
        await provider.onSessionFileChanged();
        await finishHistoryRefresh(provider);
        runtimes.phases.set(inactiveSessionId, "running");
        const nextFile = join(root, "replacement.jsonl");
        if (outcome === "replacement") {
          runtimes.files.set(activeSessionId, nextFile);
          runtimes.titles.set(activeSessionId, "Replacement");
          runtimes.phases.set(activeSessionId, "waiting-approval");
        } else runtimes.live.delete(activeSessionId);
        await tick(provider);

        const correction = webview.postMessage.mock.lastCall?.[0];
        expect(correction.type).toBe("sessionsError");
        const rows = (correction.state as WebviewState).groups.flatMap(({ sessions }) => sessions);
        expect(rows.find(({ sessionId }) => sessionId === inactiveSessionId)).toMatchObject({
          state: "waiting-user",
        });
        const corrected = rows.find(({ sessionId }) => sessionId === activeSessionId);
        if (outcome === "offline") {
          expect(corrected).toMatchObject({ displayName: "Ordinary", isInactive: true });
          expect(corrected).not.toHaveProperty("isLive");
          expect(onSessionFiles.mock.lastCall?.[0]).toContainEqual({
            id: activeSessionId,
            file: ordinary,
            isSaved: true,
          });
        } else if (outcome === "replacement") {
          expect(corrected).toMatchObject({
            displayName: "Replacement",
            isLive: true,
            state: "waiting-approval",
          });
          expect(onSessionFiles.mock.lastCall?.[0]).toContainEqual({
            id: activeSessionId,
            file: nextFile,
            isSaved: true,
          });
        } else expect(corrected).toBeUndefined();
        expect(onSessionFiles.mock.lastCall?.[0]).not.toContainEqual({
          id: activeSessionId,
          file: formerFile,
          isSaved: true,
        });

        displayedSessionId = inactiveSessionId;
        await webview.receive({ type: "ready", requestId: "after-selection" });
        expect(webview.postMessage.mock.lastCall?.[0]).toMatchObject({
          type: "sessionsError",
          requestId: "after-selection",
          state: { displayedSessionId },
        });
        await provider.onSessionFileChanged();
        expect(loadingMessages(webview).at(-1)).toMatchObject({
          displayedSessionId,
          state: { displayedSessionId },
        });
      },
    );

    it("does not requery unchanged history across list polling intervals", async () => {
      const { provider, mocks, phases, markCompletion, row } = await unreadFixture();
      mocks.history.mockClear();
      mocks.list.mockClear();
      phases.set(activeSessionId, "running");
      await tick(provider);
      markCompletion();
      await tick(provider);
      await tick(provider);
      expect(mocks.list).toHaveBeenCalledTimes(3);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      expect(mocks.history).not.toHaveBeenCalled();
    });

    it("uses CLI results for new, renamed and deleted history without reading headers", async () => {
      const { provider, mocks, history, row, sentState } = await unreadFixture();
      const file = await seedSavedSession(unknownSessionId, root, {
        runtimes: { ...sharedRuntimes, history },
      });
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(row(unknownSessionId).sessionId).toBe(unknownSessionId);
      const renamed = join(root, "sessions", "renamed.jsonl");
      await writeFile(renamed, await readFile(file));
      await rm(file);
      history.get(unknownSessionId)!.file = renamed;
      await provider.onSessionFileChanged();
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(
        sentState()
          .groups.flatMap(({ sessions }) => sessions)
          .filter(({ sessionId }) => sessionId === unknownSessionId),
      ).toHaveLength(1);
      mocks.history.mockClear();
      await rm(renamed);
      history.delete(unknownSessionId);
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(
        sentState()
          .groups.flatMap(({ sessions }) => sessions)
          .some(({ sessionId }) => sessionId === unknownSessionId),
      ).toBe(false);
    });

    it("discovers a newly saved live file even when it appeared before its custom directory watcher", async () => {
      const { provider, mocks, history, live, files, row } = await unreadFixture();
      const customFile = join(root, "custom", "new.jsonl");
      history.set(unknownSessionId, {
        id: unknownSessionId,
        cwd: root,
        file: customFile,
        title: "New custom session",
        btime: 123,
        mtime: 456,
        size: 100,
        source: "normal",
      });
      live.set(unknownSessionId, { sessionId: unknownSessionId, cwd: root, target: "pi-new" });
      files.set(unknownSessionId, customFile);
      mocks.history.mockClear();
      await tick(provider);
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(row(unknownSessionId).displayName).toBe("New custom session");
      await tick(provider);
      expect(mocks.history).toHaveBeenCalledOnce();
    });

    it("refreshes notified history without querying the list again", async () => {
      const { provider, mocks, history, row } = await unreadFixture();
      mocks.list.mockClear();
      mocks.history.mockClear();
      history.get(activeSessionId)!.title = "Changed history";
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(row().displayName).toBe("Changed history");
    });

    it("starts notified history without waiting for an in-flight list", async () => {
      const { provider, mocks, row, history } = await unreadFixture();
      const held = deferred<PiMuxWorkspace[]>();
      const workspaces = await mocks.list();
      mocks.list.mockClear();
      mocks.history.mockClear();
      mocks.list.mockReturnValueOnce(held.promise);
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      history.get(activeSessionId)!.title = "Changed during list";
      await provider.onSessionFileChanged();
      expect(mocks.list).toHaveBeenCalledOnce();
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      await finishHistoryRefresh(provider);
      expect(row().displayName).toBe("Changed during list");
      held.resolve(workspaces);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.list).toHaveBeenCalledOnce();
    });

    it("starts a notified initial refresh without advancing the clock", async () => {
      const runtime = providerRuntimes();
      const held = deferred<PiMuxWorkspace[]>();
      runtime.mocks.list.mockReturnValueOnce(held.promise);
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      void provider.onSessionFileChanged();
      held.resolve([{ cwd: root, sessions: [], empty: [] }]);
      await finishRefresh(provider);
      expect(runtime.mocks.list).toHaveBeenCalledTimes(2);
      expect(runtime.mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
    });

    it("recovers a failed list before refreshing notified history", async () => {
      const { provider, mocks, history, row } = await unreadFixture();
      mocks.list.mockRejectedValueOnce(new Error("list unavailable"));
      await tick(provider);
      mocks.list.mockClear();
      mocks.history.mockClear();
      history.get(activeSessionId)!.title = "Recovered history";
      void provider.onSessionFileChanged();
      expect(mocks.list).toHaveBeenCalledOnce();
      await finishRefresh(provider);
      await finishHistoryRefresh(provider);
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(row().displayName).toBe("Recovered history");
    });

    it("discards notified history that completes after workspace removal", async () => {
      const { provider, mocks, history, workspaces, live, sentState } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      await provider.onSessionFileChanged();
      expect(mocks.history).toHaveBeenCalledOnce();
      workspaces.clear();
      live.clear();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      expect(sentState().groups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      held.resolve([...history.values()]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentState().groups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
    });

    it("starts history immediately and batches in-flight notifications into one follow-up", async () => {
      const { provider, mocks, history, row, workspaces } = await unreadFixture();
      workspaces.add("/other");
      await tick(provider);
      const held = deferred<PiMuxHistoryEntry[]>();
      const stale = [...history.values()].map((entry) => ({ ...entry }));
      mocks.history.mockClear();
      mocks.list.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      void provider.onSessionFileChanged();
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      history.get(activeSessionId)!.title = "Saved rename";
      for (let index = 0; index < 5; index++) await provider.onSessionFileChanged();
      expect(mocks.history).toHaveBeenCalledOnce();
      held.resolve(stale);
      await finishHistoryRefresh(provider);
      expect(mocks.history.mock.calls).toEqual([[], []]);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(row().displayName).toBe("Saved rename");
    });

    it("coalesces changes arriving during history acquisition without overlapping queries", async () => {
      const { provider, mocks, history, row } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      const stale = [...history.values()].map((entry) => ({ ...entry, title: "Stale" }));
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      history.get(activeSessionId)!.title = "Latest saved title";
      await provider.onSessionFileChanged();
      await provider.onSessionFileChanged();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS * 3);
      expect(mocks.history).toHaveBeenCalledOnce();
      held.resolve(stale);
      await refresh;
      expect(mocks.history.mock.calls).toEqual([[], []]);
      expect(row().displayName).toBe("Latest saved title");
    });

    it("replaces the complete CLI snapshot rather than merging workspace histories", async () => {
      const { provider, mocks, workspaces, history, row, sentState } = await unreadFixture();
      workspaces.add("/other");
      history.set(unknownSessionId, {
        ...history.get(activeSessionId)!,
        id: unknownSessionId,
        cwd: "/other",
        file: "/missing/other.jsonl",
        title: "Other history",
      });
      mocks.history.mockClear();
      await tick(provider);
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(row(unknownSessionId).displayName).toBe("Other history");
      history.delete(unknownSessionId);
      history.get(activeSessionId)!.title = "Current CLI title";
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(row().displayName).toBe("Current CLI title");
      expect(sentState().groups.find(({ cwd }) => cwd === "/other")!.sessions).toEqual([]);
    });

    it("discards an in-flight history response after workspace removal", async () => {
      const { provider, mocks, workspaces, live, history, sentState } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history.mock.lastCall).toEqual([]));
      workspaces.delete(root);
      live.clear();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      expect(sentState().groups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      held.resolve([...history.values()]);
      await refresh;
      expect(sentState().groups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
    });

    it("rejects a history reply after the same cwd is removed and registered again", async () => {
      const { provider, mocks, history, workspaces, live, row, webview } = await unreadFixture();
      const previous = [...history.values()].map((entry) => ({
        ...entry,
        title: "Old registration",
      }));
      const held = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      workspaces.delete(root);
      live.clear();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      workspaces.add(root);
      history.get(activeSessionId)!.title = "New registration";
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      webview.postMessage.mockClear();
      held.resolve(previous);
      await refresh;
      expect(row().displayName).toBe("New registration");
      expect(mocks.history.mock.calls).toEqual([[], []]);
      expect(JSON.stringify(webview.postMessage.mock.calls)).not.toContain("Old registration");
    });

    it("defers hidden history changes until show and reuses unchanged history on later shows", async () => {
      const { provider, mocks, webview, history, row } = await unreadFixture();
      webview.setVisible(false);
      mocks.history.mockClear();
      webview.postMessage.mockClear();
      history.get(activeSessionId)!.title = "Changed while hidden";
      await provider.onSessionFileChanged();
      await tick(provider, 1_000);
      expect(mocks.history).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
      webview.setVisible(true);
      await webview.receive({ type: "ready" });
      expect(row().displayName).toBe("Changed while hidden");
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      mocks.history.mockClear();
      webview.setVisible(false);
      webview.setVisible(true);
      await webview.receive({ type: "ready" });
      expect(mocks.history).not.toHaveBeenCalled();
    });

    it("keeps changes pending when a running history request completes while hidden", async () => {
      const { provider, mocks, history, webview, row } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      const previous = [...history.values()].map((entry) => ({ ...entry }));
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      webview.setVisible(false);
      webview.postMessage.mockClear();
      history.get(activeSessionId)!.title = "Changed while hidden";
      await provider.onSessionFileChanged();
      held.resolve(previous);
      await refresh;
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(webview.postMessage).not.toHaveBeenCalled();
      webview.setVisible(true);
      await webview.receive({ type: "ready" });
      expect(mocks.history.mock.calls).toEqual([[], []]);
      expect(row().displayName).toBe("Changed while hidden");
    });

    it("refreshes history manually after a file notification", async () => {
      const { provider, mocks, history, row } = await unreadFixture();
      history.get(activeSessionId)!.title = "Manual refresh title";
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      mocks.history.mockClear();
      await provider.refresh();
      expect(mocks.history).toHaveBeenCalledExactlyOnceWith();
      expect(row().displayName).toBe("Manual refresh title");
      await finishHistoryRefresh(provider);
      expect(mocks.history).toHaveBeenCalledOnce();
    });

    it("reads all registered history on manual Refresh but not on Deactivate", async () => {
      const { provider, mocks, workspaces, webview } = await unreadFixture();
      workspaces.add("/other");
      await tick(provider);
      mocks.history.mockClear();
      await webview.receive({ type: "refresh" });
      expect(mocks.history.mock.calls).toEqual([[]]);
      mocks.history.mockClear();
      await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
      expect(mocks.history).not.toHaveBeenCalled();
    });

    it("preserves the list on history errors and backs off retries independently of list polling", async () => {
      const { provider, mocks, sentState } = await unreadFixture();
      const original = sentState();
      const readHistory = mocks.history.getMockImplementation()!;
      mocks.history.mockRejectedValue(new Error("history unavailable"));
      mocks.history.mockClear();
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(sentState()).toEqual(original);
      await tick(provider, 999);
      expect(mocks.history).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(mocks.history).toHaveBeenCalledTimes(2);
      await tick(provider, 1_999);
      expect(mocks.history).toHaveBeenCalledTimes(2);
      mocks.history.mockImplementation(readHistory);
      await tick(provider, 1);
      expect(mocks.history).toHaveBeenCalledTimes(3);
      expect(sentState()).toEqual(original);
    });

    it("retries an initial history failure automatically without querying it on every list tick", async () => {
      const runtime = providerRuntimes();
      runtime.mocks.history.mockRejectedValueOnce(new Error("initial history failure"));
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      await tick(provider, 999);
      expect(runtime.mocks.history).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(runtime.mocks.history).toHaveBeenCalledTimes(2);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
    });

    it("keeps the retrieval error after an action refresh while history retry is delayed", async () => {
      const { provider, mocks, webview } = await unreadFixture();
      mocks.history.mockClear();
      mocks.history.mockRejectedValueOnce(new Error("history unavailable"));
      await provider.refresh();
      await provider.refresh(false);
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(webview.postMessage.mock.lastCall?.[0]).toEqual({ type: "sessionsError" });
    });

    it("cancels delayed history retries when no workspaces remain", async () => {
      const { provider, mocks, workspaces, live, sentState } = await unreadFixture();
      mocks.history.mockClear();
      mocks.history.mockRejectedValueOnce(new Error("history unavailable"));
      await provider.refresh();
      workspaces.clear();
      live.clear();
      await tick(provider);
      expect(sentState().groups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      await tick(provider, 30_000);
      expect(mocks.history).toHaveBeenCalledOnce();
    });

    it("does not publish an older display projection after a newer history snapshot", async () => {
      const { provider, mocks, history, row } = await unreadFixture();
      const previous = await sessionStore.listSessionSnapshot(
        [...history.values()],
        await mocks.list(),
      );
      const heldHistory = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(heldHistory.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      const heldProjection = deferred<typeof previous>();
      const project = vi
        .spyOn(sessionStore, "listSessionSnapshot")
        .mockReturnValueOnce(heldProjection.promise);
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      expect(project).toHaveBeenCalledOnce();
      history.get(activeSessionId)!.title = "New history snapshot";
      heldHistory.resolve([...history.values()]);
      await refresh;
      expect(row().displayName).toBe("New history snapshot");
      heldProjection.resolve(previous);
      await vi.waitFor(() => expect(project).toHaveResolvedTimes(2));
      expect(row().displayName).toBe("New history snapshot");
    });

    it("keeps list polling and completion tracking running during slow history acquisition", async () => {
      const { provider, mocks, phases, markCompletion, row, history } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockReturnValueOnce(held.promise);
      mocks.list.mockClear();
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history.mock.lastCall).toEqual([]));
      phases.set(activeSessionId, "running");
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      expect(row().state).toBe("running");
      markCompletion();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      expect(mocks.list).toHaveBeenCalledTimes(3);
      held.resolve([...history.values()]);
      await refresh;
    });

    it("reflects the first user btime from CLI history without changing undated display or sorting", async () => {
      const entries: PiMuxHistoryEntry[] = [
        {
          id: "known",
          cwd: root,
          file: join(root, "known.jsonl"),
          title: "Known conversation",
          btime: 100,
          mtime: 50,
          size: 10,
          source: "normal",
        },
        ...["empty-b", "empty-a"].map((id) => ({
          id,
          cwd: root,
          file: join(root, `${id}.jsonl`),
          title: null,
          btime: null,
          mtime: null,
          size: 1,
          source: "normal" as const,
        })),
      ];
      const execute = vi.fn(async (_executable: string, args: string[]) => {
        if (args.join(" ") === "list --json") return combinedHistoryOutput(root, entries);
        return JSON.stringify([
          {
            cwd: root,
            sessions: entries.map(({ id, file }) => ({ id, file, state: null, title: null })),
            empty: [],
          },
        ]);
      });
      const registry = new TerminalRegistry(editorTerminals(), new PiMux(execute));
      const { provider } = createProvider({ registry });
      const webview = createView();
      function sentState(): WebviewState {
        return webview.postMessage.mock.calls
          .filter(([message]) => message.type === "sessions")
          .at(-1)![0].state;
      }
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });

      expect(sentState().groups[0].sessions.map(({ sessionId }) => sessionId)).toEqual([
        "known",
        "empty-a",
        "empty-b",
      ]);
      expect(sentState().groups[0].sessions[1]).toMatchObject({
        displayName: "Untitled",
        updatedAtMs: null,
      });
      expect(JSON.stringify(sessionListView(sentState()))).toContain(
        '"class":"session-timestamp"},"children":[""]',
      );

      const firstUser = entries.find(({ id }) => id === "empty-a")!;
      firstUser.btime = 200;
      firstUser.mtime = 200;
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(sentState().groups[0].sessions.map(({ sessionId }) => sessionId)).toEqual([
        "empty-a",
        "known",
        "empty-b",
      ]);
      expect(sentState().groups[0].sessions[0].updatedAtMs).toBe(200);

      entries[0].mtime = 400;
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(sentState().groups[0].sessions.map(({ sessionId }) => sessionId)).toEqual([
        "empty-a",
        "known",
        "empty-b",
      ]);
      expect(sentState().groups[0].sessions[1].updatedAtMs).toBe(400);
      expect(execute).toHaveBeenCalledWith("pi-mux", ["list", "--json"], undefined);
    });

    it.each([
      { visibility: "shown", isVisible: true, count: 4 },
      { visibility: "hidden", isVisible: false, count: 1 },
    ])(
      "polls $count times in one second when the list is $visibility",
      async ({ isVisible, count }) => {
        const { webview, mocks } = await unreadFixture();
        if (!isVisible) webview.setVisible(false);
        mocks.list.mockClear();

        await vi.advanceTimersByTimeAsync(1_000);

        expect(mocks.list).toHaveBeenCalledTimes(count);
      },
    );

    it("replaces the scheduled visible poll using the last completion time when hidden", async () => {
      const { mocks, webview } = await unreadFixture();
      mocks.list.mockClear();
      const elapsedBeforeHideMs = 200;
      await vi.advanceTimersByTimeAsync(elapsedBeforeHideMs);
      webview.setVisible(false);

      await vi.advanceTimersByTimeAsync(999 - elapsedBeforeHideMs);
      expect(mocks.list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.list).toHaveBeenCalledOnce();
    });

    it("waits for a slow query before scheduling the next interval", async () => {
      const { provider, mocks, holdRuntimeQuery } = await unreadFixture();
      mocks.list.mockClear();
      const held = holdRuntimeQuery();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      await held.started;
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS * 10);
      expect(mocks.list).toHaveBeenCalledOnce();
      held.finish();
      await finishRefresh(provider);
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS - 1);
      expect(mocks.list).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(mocks.list).toHaveBeenCalledTimes(2);
    });

    it("updates membership, title, workspace and phases at each refresh interval without JSON writes", async () => {
      const fixture = await unreadFixture();
      const {
        provider,
        phases,
        markCompletion,
        titles,
        live,
        workspaces,
        row,
        statePath,
        mocks,
        sentState,
      } = fixture;
      const original = await readFile(statePath, "utf8");
      mocks.list.mockClear();
      phases.set(activeSessionId, "running");
      titles.set(activeSessionId, "Live title");
      workspaces.add("/new-empty");
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS - 1);
      expect(mocks.list).not.toHaveBeenCalled();
      await tick(provider, 1);
      expect(row()).toMatchObject({ state: "running", displayName: "Live title" });
      expect(sentState().groups.some(({ cwd }) => cwd === "/new-empty")).toBe(true);
      markCompletion();
      await tick(provider);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      live.delete(activeSessionId);
      await tick(provider);
      expect(row()).toMatchObject({ isInactive: true, state: undefined, hasUnread: false });
      expect(await readFile(statePath, "utf8")).toBe(original);
    });

    it("continues list acquisition while hidden without JSONL reads or UI delivery", async () => {
      const { provider, webview, mocks, phases, markCompletion, row } = await unreadFixture();
      const scan = vi.spyOn(sessionStore, "listSessionSnapshot");
      mocks.list.mockClear();
      mocks.history.mockClear();
      webview.postMessage.mockClear();
      webview.setVisible(false);
      phases.set(activeSessionId, "running");
      await tick(provider, 2_000);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(mocks.history).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
      markCompletion();
      webview.setVisible(true);
      expect(mocks.list).toHaveBeenCalledTimes(3);
      await webview.receive({ type: "ready" });
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("starts the visible list immediately without waiting for pending history", async () => {
      const { provider, webview, mocks, history } = await unreadFixture();
      const heldHistory = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(heldHistory.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      webview.setVisible(false);
      mocks.list.mockClear();
      webview.setVisible(true);
      const listCallsOnShow = mocks.list.mock.calls.length;
      heldHistory.resolve([...history.values()]);
      await refresh;
      await finishRefresh(provider);

      expect(listCallsOnShow).toBe(1);
    });

    it.each([
      { trigger: "show", historyOutcome: "success", listOutcome: "success" },
      { trigger: "show", historyOutcome: "failure", listOutcome: "success" },
      { trigger: "operation", historyOutcome: "success", listOutcome: "failure" },
    ])(
      "keeps $trigger loading until list $listOutcome when earlier history reports $historyOutcome",
      async ({ trigger, historyOutcome, listOutcome }) => {
        const { provider, webview, mocks, history, sentState } = await unreadFixture();
        const previousState = sentState();
        const heldHistory = deferred<PiMuxHistoryEntry[]>();
        const heldList = deferred<PiMuxWorkspace[]>();
        const refreshedWorkspaces = await mocks.list();
        mocks.history.mockClear();
        mocks.history.mockReturnValueOnce(heldHistory.promise);
        const oldRefresh = provider.refresh();
        await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
        mocks.list.mockClear();
        mocks.list.mockReturnValueOnce(heldList.promise);
        const earlierPosts = webview.postMessage.mock.calls.length;
        if (trigger === "show") {
          webview.setVisible(false);
          webview.setVisible(true);
        } else {
          void provider.refresh(false);
        }
        expect(mocks.list).toHaveBeenCalledOnce();
        if (historyOutcome === "failure") heldHistory.reject(new Error("history unavailable"));
        else {
          history.get(activeSessionId)!.title = "Refreshed history";
          heldHistory.resolve([...history.values()]);
        }
        await oldRefresh;
        const messagesBeforeListFinished = webview.postMessage.mock.calls
          .slice(earlierPosts)
          .map(([message]) => message.type);
        if (listOutcome === "failure") heldList.reject(new Error("list unavailable"));
        else heldList.resolve(refreshedWorkspaces);
        await finishRefresh(provider);

        expect(messagesBeforeListFinished).toEqual(["loading"]);
        const completions = webview.postMessage.mock.calls
          .slice(earlierPosts + 1)
          .map(([message]) => message.type);
        if (historyOutcome === "failure" || listOutcome === "failure") {
          expect(completions).toEqual(["sessionsError"]);
          expect(sentState()).toEqual(previousState);
        } else {
          expect(completions).toEqual(["sessions"]);
          expect(sentState().groups.flatMap(({ sessions }) => sessions)).toContainEqual(
            expect.objectContaining({
              sessionId: activeSessionId,
              displayName: "Refreshed history",
            }),
          );
        }
      },
    );

    it("does not publish earlier history while a visible view awaits a new list", async () => {
      const { provider, webview, mocks, history, holdRuntimeQuery } = await unreadFixture();
      const heldHistory = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(heldHistory.promise);
      const previousRefresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      const heldList = holdRuntimeQuery();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      await heldList.started;
      webview.setVisible(false);
      webview.setVisible(true);
      webview.postMessage.mockClear();

      history.get(activeSessionId)!.title = "Refreshed history";
      heldHistory.resolve([...history.values()]);
      await previousRefresh;
      const earlyPosts = webview.postMessage.mock.calls.map(([message]) => message.type);
      heldList.finish();
      await finishRefresh(provider);

      expect(earlyPosts).toEqual([]);
      expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "loading",
        "sessions",
      ]);
    });

    it("only reports the fresh list outcome when a visible view awaits a new list", async () => {
      const { provider, mocks } = await unreadFixture();
      const heldList = deferred<PiMuxWorkspace[]>();
      mocks.list.mockReturnValueOnce(heldList.promise);
      const previousRefresh = provider.refreshManually();
      const replacement = createView();
      provider.resolveWebviewView(replacement.view as never);
      heldList.reject(new Error("previous list unavailable"));
      await previousRefresh;
      await finishRefresh(provider);

      expect(replacement.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "loading",
        "sessions",
      ]);
    });

    it("publishes the latest list after an older history projection completes", async () => {
      const { provider, mocks, history, phases, row } = await unreadFixture();
      const previous = await sessionStore.listSessionSnapshot(
        [...history.values()],
        await mocks.list(),
      );
      const heldProjection = deferred<typeof previous>();
      const project = vi.spyOn(sessionStore, "listSessionSnapshot");
      project.mockReturnValueOnce(heldProjection.promise);
      const oldRefresh = provider.refresh();
      await vi.waitFor(() => expect(project).toHaveBeenCalledOnce());
      phases.set(activeSessionId, "running");
      const newRefresh = provider.refresh(false);
      await vi.advanceTimersByTimeAsync(0);

      heldProjection.resolve(previous);
      await Promise.all([oldRefresh, newRefresh]);
      expect(row().state).toBe("running");
    });

    it("starts the visible list immediately while the prior workspace snapshot is being applied", async () => {
      const { provider, webview, mocks } = await unreadFixture();
      const heldWorkspaces = deferred<Set<string>>();
      workspaceStorage.list.mockClear();
      workspaceStorage.list.mockReturnValueOnce(heldWorkspaces.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(workspaceStorage.list).toHaveBeenCalledOnce());
      webview.setVisible(false);
      mocks.list.mockClear();
      webview.setVisible(true);
      const listCallsOnShow = mocks.list.mock.calls.length;
      heldWorkspaces.resolve(new Set([root]));
      await refresh;
      await finishRefresh(provider);

      expect(listCallsOnShow).toBe(1);
    });

    it("retries after initial and later failures without replacing the last list", async () => {
      const { provider, mocks, webview } = await loadingFixture();
      mocks.list.mockRejectedValueOnce(new Error("offline"));
      await provider.refresh();
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      await tick(provider);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
      const {
        row,
        setPhase,
        markCompletion,
        mocks: runtimeMocks,
        provider: other,
      } = await unreadFixture();
      await setPhase("running");
      runtimeMocks.list.mockRejectedValueOnce(new Error("offline"));
      markCompletion();
      await tick(other);
      expect(row()).toMatchObject({ state: "running", hasUnread: false });
      await tick(other);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("retries an initial list failure without requiring another user action", async () => {
      const runtime = providerRuntimes();
      runtime.mocks.list.mockRejectedValueOnce(new Error("initial failure"));
      const onWorkspaces = vi.fn();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
        onWorkspaces,
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      expect(onWorkspaces).not.toHaveBeenCalled();
      await tick(provider);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
      expect(onWorkspaces).toHaveBeenCalledWith([root]);
    });

    it("resends the unchanged list after a polling error and replays the recovered list on ready", async () => {
      const { provider, webview, mocks, sentState } = await unreadFixture();
      const state = sentState();
      mocks.list.mockRejectedValueOnce(new Error("offline"));
      await tick(provider);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();

      webview.postMessage.mockClear();
      await tick(provider);
      expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "sessions", state });
      webview.postMessage.mockClear();
      await webview.receive({ type: "ready" });
      expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "sessions", state });
    });

    it("resends the unchanged list after an action error", async () => {
      const { provider, webview, sentState } = await unreadFixture();
      const state = sentState();
      await webview.receive({ type: "openSession", sessionId: "unknown" });
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("error");

      webview.postMessage.mockClear();
      await tick(provider);
      expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "sessions", state });
    });

    it.each(["false", "rejection"])(
      "retries an unchanged list after delivery %s",
      async (failure) => {
        const { provider, webview, phases, sentState } = await unreadFixture();
        if (failure === "false") webview.postMessage.mockResolvedValueOnce(false);
        else webview.postMessage.mockRejectedValueOnce(new Error("delivery failed"));
        phases.set(activeSessionId, "running");
        await tick(provider);
        const state = sentState();
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();

        webview.postMessage.mockClear();
        await tick(provider);
        expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "sessions", state });
        webview.postMessage.mockClear();
        await tick(provider);
        expect(webview.postMessage).not.toHaveBeenCalled();
      },
    );

    it("acquires the first list immediately and polls every second before a view exists", async () => {
      const runtime = providerRuntimes();
      const onWorkspaces = vi.fn();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
        onWorkspaces,
      });
      const initialRefresh = provider.refresh();
      expect(runtime.mocks.list).toHaveBeenCalledOnce();
      await initialRefresh;
      expect(onWorkspaces).toHaveBeenLastCalledWith([root]);
      runtime.workspaces.add("/added");
      await tick(provider, 999);
      expect(runtime.mocks.list).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(runtime.mocks.list).toHaveBeenCalledTimes(2);
      expect(onWorkspaces).toHaveBeenLastCalledWith([root, "/added"]);
      expect(workspaceStorage.add).toHaveBeenCalledWith("/added");
      expect(runtime.mocks.history).not.toHaveBeenCalled();
    });

    it("waits a second after a hidden failure and treats the next empty response as success", async () => {
      const runtime = providerRuntimes();
      const onWorkspaces = vi.fn();
      const log = { error: vi.fn() };
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
        onWorkspaces,
        log,
      });
      await provider.refresh();
      runtime.mocks.list.mockClear();
      const heldList = deferred<PiMuxWorkspace[]>();
      runtime.mocks.list.mockReturnValueOnce(heldList.promise).mockResolvedValueOnce([]);
      await tick(provider, 1_000);
      await tick(provider, 2_000);
      expect(runtime.mocks.list).toHaveBeenCalledOnce();
      heldList.reject(new Error("offline"));

      await tick(provider, 999);
      expect(runtime.mocks.list).toHaveBeenCalledOnce();
      expect(log.error).toHaveBeenCalledOnce();
      expect(onWorkspaces.mock.calls).toEqual([[[root]]]);
      await tick(provider, 1);
      expect(runtime.mocks.list).toHaveBeenCalledTimes(2);
      expect(onWorkspaces.mock.calls).toEqual([[[root]], [[]]]);
    });

    it("keeps published file directories on failure and releases them after a successful empty reply", async () => {
      const runtime = providerRuntimes();
      const entry = {
        id: activeSessionId,
        cwd: root,
        file: "/custom/history/session.jsonl",
        title: "CLI history",
        btime: 1,
        mtime: 2,
        size: 10,
        source: "normal" as const,
      };
      const planned = { id: "planned", file: "/custom/planned/session.jsonl", isSaved: false };
      runtime.history.set(entry.id, entry);
      runtime.live.set("planned", { sessionId: "planned", cwd: root, target: "pi-planned" });
      runtime.emptyIds.add("planned");
      runtime.files.set("planned", planned.file);
      const observe = vi.fn();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
        onSessionFiles: observe,
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      const expectedFiles = [{ id: entry.id, file: entry.file, isSaved: true }, planned];
      expect(observe.mock.lastCall?.[0]).toEqual(expectedFiles);
      runtime.history.clear();
      runtime.mocks.history.mockRejectedValueOnce(new Error("unavailable"));
      await provider.onSessionFileChanged();
      await finishHistoryRefresh(provider);
      expect(observe.mock.lastCall?.[0]).toEqual(expectedFiles);
      await provider.refresh();
      expect(observe.mock.lastCall?.[0]).toEqual([planned]);
      runtime.emptyIds.delete(planned.id);
      await tick(provider);
      expect(observe.mock.lastCall?.[0]).toEqual([{ ...planned, isSaved: true }]);
      runtime.live.clear();
      await tick(provider);
      expect(observe.mock.lastCall?.[0]).toEqual([]);
    });

    it("skips posting while the list state is unchanged", async () => {
      const { provider, webview } = await unreadFixture();
      await tick(provider);
      webview.postMessage.mockClear();
      await tick(provider);
      await tick(provider);
      const sessionPosts = webview.postMessage.mock.calls.filter(
        ([message]) => message.type === "sessions",
      );
      expect(sessionPosts).toHaveLength(0);
    });

    it("posts again when the list state changes", async () => {
      const { provider, webview, phases, row } = await unreadFixture();
      await tick(provider);
      webview.postMessage.mockClear();
      phases.set(activeSessionId, "running");
      await tick(provider);
      const post = webview.postMessage.mock.calls.find(([message]) => message.type === "sessions");
      expect(post).toBeDefined();
      expect(row()).toMatchObject({ state: "running" });
    });

    it("does not accept or retry a history reply after provider disposal", async () => {
      const { provider, mocks, webview } = await unreadFixture();
      const held = deferred<PiMuxHistoryEntry[]>();
      mocks.history.mockClear();
      mocks.history.mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(mocks.history).toHaveBeenCalledOnce());
      provider.dispose();
      webview.postMessage.mockClear();
      held.reject(new Error("history unavailable"));
      await refresh;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(webview.postMessage).not.toHaveBeenCalled();
    });

    it.each(["view", "provider"])("drops replies after %s disposal", async (target) => {
      const { provider, webview, mocks, holdRuntimeQuery } = await unreadFixture();
      const held = holdRuntimeQuery();
      mocks.list.mockClear();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      await held.started;
      if (target === "view") webview.dispose();
      else provider.dispose();
      webview.postMessage.mockClear();
      held.finish();
      await finishRefresh(provider);
      await tick(provider, 999);
      expect(mocks.list).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(webview.postMessage).not.toHaveBeenCalled();
      expect(mocks.list).toHaveBeenCalledTimes(target === "view" ? 2 : 1);
    });

    it.each(["hidden", "shown again", "hidden with a manual refresh"])(
      "revalidates a queued visibility refresh when the view is %s",
      async (viewState) => {
        const { provider, webview, mocks, holdRuntimeQuery } = await unreadFixture();
        const held = holdRuntimeQuery();
        mocks.list.mockClear();
        await tick(provider);
        await held.started;
        webview.setVisible(false);
        webview.setVisible(true);
        if (viewState === "hidden with a manual refresh") void provider.refreshManually();
        webview.setVisible(false);
        if (viewState === "shown again") webview.setVisible(true);
        expect(mocks.list).toHaveBeenCalledOnce();

        held.finish();
        await finishRefresh(provider);
        if (viewState === "hidden") {
          await tick(provider, 999);
          expect(mocks.list).toHaveBeenCalledOnce();
          await tick(provider, 1);
        }
        expect(mocks.list).toHaveBeenCalledTimes(2);
      },
    );

    it.each(["hidden", "disposed", "visible"])(
      "only refreshes a recreated view immediately if it stays visible (%s)",
      async (viewState) => {
        const { provider, mocks, holdRuntimeQuery } = await unreadFixture();
        const held = holdRuntimeQuery();
        mocks.list.mockClear();
        await tick(provider);
        await held.started;
        const replacement = createView();
        provider.resolveWebviewView(replacement.view as never);
        if (viewState === "hidden") replacement.setVisible(false);
        if (viewState === "disposed") replacement.dispose();
        expect(mocks.list).toHaveBeenCalledOnce();

        held.finish();
        await finishRefresh(provider);
        if (viewState === "visible") {
          expect(mocks.list).toHaveBeenCalledTimes(2);
          expect(replacement.postMessage.mock.lastCall?.[0].type).toBe("sessions");
          return;
        }
        expect(mocks.list).toHaveBeenCalledOnce();
        await tick(provider, 999);
        expect(mocks.list).toHaveBeenCalledOnce();
        await tick(provider, 1);
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(replacement.postMessage).not.toHaveBeenCalled();
      },
    );

    it("preserves background polling when a recreated view starts hidden", async () => {
      const { provider, mocks } = await unreadFixture();
      mocks.list.mockClear();
      const elapsedBeforeResolveMs = 200;
      await tick(provider, elapsedBeforeResolveMs);
      const replacement = createView();
      replacement.setVisible(false);
      provider.resolveWebviewView(replacement.view as never);

      await tick(provider, 999 - elapsedBeforeResolveMs);
      expect(mocks.list).not.toHaveBeenCalled();
      await tick(provider, 1);
      expect(mocks.list).toHaveBeenCalledOnce();
      expect(replacement.postMessage).not.toHaveBeenCalled();
    });

    it.each([
      ["startup", "hidden"],
      ["manual", "hidden after showing"],
      ["manual", "disposed after showing"],
    ])(
      "accepts an in-flight %s response when the replacement view is %s",
      async (trigger, visibility) => {
        const runtime = providerRuntimes();
        const onWorkspaces = vi.fn();
        const { provider } = createProvider({
          registry: new TerminalRegistry(editorTerminals(), runtime.mux),
          onWorkspaces,
        });
        const held = deferred<PiMuxWorkspace[]>();
        runtime.mocks.list.mockReturnValueOnce(held.promise);
        const refresh = trigger === "startup" ? provider.refresh() : provider.refreshManually();
        const replacement = createView();
        if (visibility === "hidden") replacement.setVisible(false);
        provider.resolveWebviewView(replacement.view as never);
        if (visibility === "hidden after showing") replacement.setVisible(false);
        if (visibility === "disposed after showing") replacement.dispose();

        held.resolve([{ cwd: root, sessions: [], empty: [] }]);
        await refresh;
        expect(runtime.mocks.list).toHaveBeenCalledOnce();
        expect(onWorkspaces).toHaveBeenCalledExactlyOnceWith([root]);
        expect(replacement.postMessage).not.toHaveBeenCalled();
      },
    );

    it("does not start a refresh queued by showing the view after provider disposal", async () => {
      const { provider, webview, mocks, holdRuntimeQuery } = await unreadFixture();
      const held = holdRuntimeQuery();
      mocks.list.mockClear();
      await tick(provider);
      await held.started;
      webview.setVisible(false);
      webview.setVisible(true);
      provider.dispose();

      held.finish();
      await tick(provider, 2_000);
      expect(mocks.list).toHaveBeenCalledOnce();
    });

    it("starts a new list as soon as an in-flight pre-hide list completes without publishing it", async () => {
      const { provider, webview, mocks, phases, row, holdRuntimeQuery } = await unreadFixture();
      mocks.list.mockClear();
      phases.set(activeSessionId, "running");
      const held = holdRuntimeQuery();
      await vi.advanceTimersByTimeAsync(LIST_REFRESH_INTERVAL_MS);
      await held.started;
      webview.setVisible(false);
      phases.set(activeSessionId, "waiting-approval");
      webview.setVisible(true);
      const ready = webview.receive({ type: "ready" });
      expect(mocks.list).toHaveBeenCalledOnce();
      held.finish();
      await ready;
      await finishRefresh(provider);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(row().state).toBe("waiting-approval");
    });
  });

  it("follows the shared terminal's displayed session in the sent state", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    // before any open the shared terminal shows no session
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBeUndefined();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    // opening re-sends the list with the displayed session so the selection follows
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  describe("selection follows the new session display", () => {
    let fixture: Awaited<ReturnType<typeof inactiveDisplayFixture>>;
    let launcher: SessionLauncher;
    let onSessionStarted: Mock<(sessionId: string) => Promise<void>>;

    beforeEach(async () => {
      fixture = await inactiveDisplayFixture({
        startNewSession: (cwd, onPresented) => launcher.start(cwd, onPresented),
      });
      onSessionStarted = vi.fn((_sessionId: string) => fixture.provider.refresh());
      launcher = new SessionLauncher({
        registry: fixture.registry,
        onSessionStarted,
      });
      await fixture.webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(selectedRows()).toHaveLength(1);
    });

    afterEach(() => {
      launcher?.dispose();
      fixture?.provider.dispose();
    });

    function sentState(): WebviewState {
      let state: WebviewState = { groups: [] };
      for (const [message] of fixture.webview.postMessage.mock.calls) {
        if (message.type === "sessions") state = message.state;
        if (message.type === "loading" && "displayedSessionId" in message) {
          state = { ...state, displayedSessionId: message.displayedSessionId ?? undefined };
        }
      }
      return state;
    }

    function selectedRows() {
      const state = sentState();
      return sessionListView(state, new Map(), state.displayedSessionId)
        .sessions.flatMap((group) => group.children ?? [])
        .filter(
          (row) => typeof row !== "string" && row.attrs?.class?.split(" ").includes("selected"),
        );
    }

    it("clears the old row selection before the new session is saved", async () => {
      await fixture.webview.receive({ type: "newSession", cwd: root });

      const displayedId = fixture.registry.displayedSessionId;
      expect(displayedId).toBeDefined();
      expect(displayedId).not.toBe(activeSessionId);
      expect(fixture.terminal.show).toHaveBeenCalledTimes(3);
      expect(onSessionStarted).toHaveBeenCalledWith(displayedId);

      const listedIds = sentState().groups.flatMap((group) =>
        group.sessions.map((session) => session.sessionId),
      );
      expect(listedIds).toContain(activeSessionId);
      expect(listedIds).not.toContain(displayedId);
      expect(selectedRows()).toHaveLength(0);
      expect(sentState().displayedSessionId).toBe(displayedId);
    });

    it("clears the old selection while the new session list scan is pending", async () => {
      const sessions = await sessionStore.listSessionSnapshot(
        await fixture.registry.mux.history(),
        await fixture.registry.mux.list(),
      );
      let finish!: (result: typeof sessions) => void;
      const scan = vi.spyOn(sessionStore, "listSessionSnapshot").mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const launching = fixture.webview.receive({ type: "newSession", cwd: root });
      try {
        await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
        expect(fixture.registry.displayedSessionId).not.toBe(activeSessionId);
        expect(selectedRows()).toHaveLength(0);
        expect(sentState().displayedSessionId).toBe(fixture.registry.displayedSessionId);
        expect(fixture.webview.postMessage.mock.lastCall?.[0].type).toBe("loading");
        expect(sentState().groups[0].sessions).not.toHaveLength(0);
      } finally {
        finish(sessions);
        await launching;
      }
    });

    it.each(["state store", "session list"] as const)(
      "keeps the old row deselected when the %s cannot be read",
      async (source) => {
        if (source === "state store") {
          onSessionStarted.mockImplementationOnce(async () => {
            await writeFile(fixture.statePath, "invalid json");
            await fixture.provider.refresh();
          });
        } else {
          vi.spyOn(sessionStore, "listSessionSnapshot").mockRejectedValue(new Error("scan failed"));
        }

        await fixture.webview.receive({ type: "newSession", cwd: root });
        const displayedId = fixture.registry.displayedSessionId;
        expect(displayedId).not.toBe(activeSessionId);
        expect(selectedRows()).toHaveLength(0);
        expect(sentState().displayedSessionId).toBe(displayedId);
        expect(sentState().groups[0].sessions).not.toHaveLength(0);
        expect(fixture.webview.postMessage.mock.lastCall?.[0].type).toBe(
          source === "state store" ? "sessions" : "sessionsError",
        );

        await fixture.provider.refresh();
        expect(selectedRows()).toHaveLength(0);
        expect(sentState().displayedSessionId).toBe(displayedId);
        expect(fixture.webview.postMessage.mock.lastCall?.[0].type).toBe(
          source === "state store" ? "sessions" : "sessionsError",
        );
      },
    );

    it("selects the displayed new session when its saved row appears", async () => {
      await fixture.webview.receive({ type: "newSession", cwd: root });
      const displayedId = fixture.registry.displayedSessionId!;
      await seedSavedSession(displayedId, root, { runtimes: fixture.runtimes });

      await fixture.webview.receive({ type: "refresh" });
      expect(sentState().displayedSessionId).toBe(displayedId);
      expect(selectedRows()).toHaveLength(1);
      const newRow = sentState()
        .groups.flatMap((group) => group.sessions)
        .find((session) => session.sessionId === displayedId);
      expect(newRow?.isInactive).toBe(false);
    });

    it("keeps the current display selected when an earlier new session is saved and refreshed", async () => {
      await fixture.webview.receive({ type: "newSession", cwd: root });
      const pendingId = fixture.registry.displayedSessionId!;

      await fixture.webview.receive({ type: "openSession", sessionId: activeSessionId });
      await seedSavedSession(pendingId, root, { runtimes: fixture.runtimes });

      await fixture.webview.receive({ type: "refresh" });
      expect(
        sentState().groups.flatMap((group) => group.sessions.map((session) => session.sessionId)),
      ).toContain(pendingId);
      expect(fixture.registry.displayedSessionId).toBe(activeSessionId);
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(selectedRows()).toHaveLength(1);
    });

    it("clears the old selection when reconnecting to an unsaved new session", async () => {
      await fixture.webview.receive({ type: "newSession", cwd: root });
      const pendingId = fixture.registry.displayedSessionId!;
      await fixture.webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(selectedRows()).toHaveLength(1);

      fixture.runtimes.mocks.newSession.mockResolvedValueOnce(pendingId);
      await fixture.webview.receive({ type: "newSession", cwd: root });

      expect(fixture.runtimes.mocks.newSession).toHaveBeenLastCalledWith(root);
      expect(fixture.registry.displayedSessionId).toBe(pendingId);
      expect(onSessionStarted).toHaveBeenLastCalledWith(pendingId);
      expect(selectedRows()).toHaveLength(0);
      expect(sentState().displayedSessionId).toBe(pendingId);
    });

    it("keeps the displayed row selected when the new launch fails", async () => {
      const selectedBefore = selectedRows();
      fixture.runtimes.mocks.newSession.mockRejectedValueOnce(new Error("launch failed"));

      await fixture.webview.receive({ type: "newSession", cwd: root });

      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("launch failed"),
      );
      expect(fixture.registry.displayedSessionId).toBe(activeSessionId);
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(selectedRows()).toEqual(selectedBefore);
    });

    it("finishes the request after presentation while the session refresh is pending", async () => {
      const refresh = deferred<void>();
      onSessionStarted.mockReturnValueOnce(refresh.promise);
      const launching = fixture.webview.receive({
        type: "newSession",
        cwd: root,
        requestId: "pending-refresh",
      });
      try {
        await vi.waitFor(() => expect(onSessionStarted).toHaveBeenCalledOnce());
        const completions = fixture.webview.postMessage.mock.calls.filter(
          ([message]) => message.type === "newSessionFinished",
        );
        expect(completions.map(([message]) => message)).toEqual([
          { type: "newSessionFinished", requestId: "pending-refresh" },
        ]);
        expect(fixture.terminal.show).toHaveBeenCalledTimes(3);
      } finally {
        refresh.resolve();
        await launching;
      }
      expect(
        fixture.webview.postMessage.mock.calls.filter(
          ([message]) => message.type === "newSessionFinished",
        ),
      ).toHaveLength(1);
    });

    it.each(["invalid cwd", "creation", "connection"] as const)(
      "finishes the failed request for %s",
      async (failure) => {
        if (failure === "creation")
          fixture.runtimes.mocks.newSession.mockRejectedValueOnce(new Error("creation failed"));
        if (failure === "connection")
          fixture.runtimes.mocks.current.mockRejectedValueOnce(new Error("connection failed"));
        await fixture.webview.receive({
          type: "newSession",
          cwd: failure === "invalid cwd" ? join(root, "missing") : root,
          requestId: "failed-request",
        });
        const completions = fixture.webview.postMessage.mock.calls.filter(
          ([message]) => message.type === "newSessionFinished",
        );
        expect(completions.map(([message]) => message)).toEqual([
          { type: "newSessionFinished", requestId: "failed-request" },
        ]);
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalled();
      },
    );
  });

  it("uses the public mux phase independently of legacy JSON", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    const { live, phases } = runtimes;
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    phases.set(activeSessionId, "waiting-approval");
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].state).toBe(
      "waiting-approval",
    );
  });

  it("drops the phase of a session absent from the pi-mux list (stale sweep)", async () => {
    await seedSavedSession(activeSessionId);
    const registry = createRegistry();
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(
      webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].state,
    ).toBeUndefined();
  });

  it("projects mux phases into icons without JSON phase writes", async () => {
    const { setPhase, row, sentState, statePath } = await unreadFixture();
    const savedState = await readFile(statePath, "utf8");
    await setPhase("running");
    expect(row()).toMatchObject({ state: "running", hasUnread: false });
    expect(JSON.stringify(sessionListView(sentState()))).toContain('"data-state":"running"');
    expect(await readFile(statePath, "utf8")).toBe(savedState);
  });

  it("projects the public state field through the real mux adapter and client", async () => {
    const filePath = await seedSavedSession(activeSessionId);
    let phase: SessionPhase = "running";
    const execute = vi.fn(async (_executable: string, args: string[]) => {
      if (args.join(" ") === "list --json")
        return combinedHistoryOutput(root, [sharedRuntimes.history.get(activeSessionId)!]);
      return JSON.stringify([
        {
          cwd: root,
          sessions: [
            {
              id: activeSessionId,
              file: filePath,
              state: phase,
              title: null,
            },
          ],
          empty: [],
        },
      ]);
    });
    const mux = new PiMux(execute);
    const registry = new TerminalRegistry(editorTerminals(), mux);
    const { provider, statePath } = createProvider({ registry });

    const savedState = await readFile(statePath, "utf8");
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await webview.receive({ type: "ready" });
    for (const next of ["running", "waiting-approval", "waiting-user"] as const) {
      phase = next;
      await provider.refresh();
      const state = webview.postMessage.mock.calls.at(-1)?.[0].state as WebviewState;
      expect(state.groups[0].sessions[0].state).toBe(phase);
      expect(JSON.stringify(sessionListView(state))).toContain(`"data-state":"${phase}"`);
    }
    expect(execute).toHaveBeenCalledWith("pi-mux", ["list", "--active", "--json"], undefined);
    expect(await readFile(statePath, "utf8")).toBe(savedState);
  });

  describe("unread completion", () => {
    const completedAtMs = 1_700_000_000_000;

    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

    it("remains read without a settlement even after observing a run", async () => {
      const { setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-approval");
      expect(row()).toMatchObject({ state: "waiting-approval", hasUnread: false });
      await setPhase("waiting-user");
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("shows a normal completion without observing a run, but not a later abort", async () => {
      const { complete, row } = await unreadFixture();
      await complete(completedAtMs);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await complete(completedAtMs + 1, true);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("hides a previous unread completion while a new run is active", async () => {
      const { complete, setPhase, row } = await unreadFixture();
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);
      await setPhase("running");
      expect(row()).toMatchObject({ state: "running", hasUnread: false });
      await setPhase("waiting-approval");
      expect(row()).toMatchObject({ state: "waiting-approval", hasUnread: false });
      await complete(completedAtMs + 1);
      expect(row().hasUnread).toBe(true);
    });

    it.each([true, false])(
      "marks a run completed after opening as unread with the list visible=%s",
      async (visible) => {
        const { provider, webview, registry, terminal, setPhase, complete, row } =
          await unreadFixture();
        await setPhase("running");
        vi.setSystemTime(completedAtMs - 1);
        await webview.receive({ type: "openSession", sessionId: activeSessionId });
        webview.setVisible(visible);
        await complete(completedAtMs);
        if (!visible) {
          webview.setVisible(true);
          await webview.receive({ type: "ready" });
        }
        expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
        registry.onTerminalClosed(terminal as never);
        await provider.refresh();
        expect(row().hasUnread).toBe(true);
      },
    );

    it("acknowledges a displayed completion on reselection, including at the same timestamp", async () => {
      const { provider, webview, complete, row, sentState } = await unreadFixture();
      vi.setSystemTime(completedAtMs - 1);
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);

      vi.setSystemTime(completedAtMs);
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(row().hasUnread).toBe(false);
      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      await provider.refresh();
      expect(row().hasUnread).toBe(false);
    });

    it.each([false, true])(
      "restores unread from the same store after provider restart (previously opened=%s)",
      async (opened) => {
        const { provider, mux, complete, webview, row, sentState } = await unreadFixture();
        await complete(completedAtMs);
        expect(row().hasUnread).toBe(true);
        if (opened) {
          vi.setSystemTime(completedAtMs + 1);
          await webview.receive({ type: "openSession", sessionId: activeSessionId });
          expect(row().hasUnread).toBe(false);
        }
        expect([...sessionOpenState.saved.values()]).toEqual(opened ? [completedAtMs + 1] : []);
        provider.dispose();

        const { provider: replacement } = createProvider({
          registry: new TerminalRegistry(editorTerminals(), mux),
        });
        const replacementView = createView();
        replacement.resolveWebviewView(replacementView.view as never);
        await replacementView.receive({ type: "ready" });
        expect(sentState(replacementView).groups[0].sessions).toContainEqual(
          expect.objectContaining({ sessionId: activeSessionId, hasUnread: !opened }),
        );
      },
    );

    it("restores unread on webview recreation even without a run observation", async () => {
      const { provider, complete, sentState } = await unreadFixture();
      await complete(completedAtMs);
      const replacement = createView();
      provider.resolveWebviewView(replacement.view as never);
      await replacement.receive({ type: "ready" });
      expect(sentState(replacement).groups[0].sessions).toContainEqual(
        expect.objectContaining({ sessionId: activeSessionId, hasUnread: true }),
      );
    });

    it.each([false, true])(
      "does not record an unsuccessful open with displayed=%s",
      async (displayed) => {
        const { provider, mocks, webview, complete, row } = await unreadFixture();
        if (displayed) {
          vi.setSystemTime(completedAtMs - 1);
          await webview.receive({ type: "openSession", sessionId: activeSessionId });
        }
        await complete(completedAtMs);
        vi.setSystemTime(completedAtMs + 1);
        sessionOpenState.update.mockClear();
        mocks.list.mockRejectedValueOnce(new Error("cannot attach"));

        await webview.receive({ type: "openSession", sessionId: activeSessionId });
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining("cannot attach"),
        );
        expect(sessionOpenState.update).not.toHaveBeenCalled();
        await provider.refresh();
        expect(row().hasUnread).toBe(true);
      },
    );

    it("does not record a presentation that throws before showing the terminal", async () => {
      const { webview, complete, row, terminal } = await unreadFixture();
      await complete(completedAtMs);
      terminal.show.mockImplementationOnce(() => {
        throw new Error("cannot show terminal");
      });

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("cannot show terminal"),
      );
      expect(sessionOpenState.update).not.toHaveBeenCalled();
      expect(row().hasUnread).toBe(true);
    });

    it("preserves unread through a transient pi-mux list failure", async () => {
      const { provider, mocks, complete, row } = await unreadFixture();
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);

      mocks.list.mockRejectedValueOnce(new Error("lookup failed"));
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("clears a bell on successful open while saved history is unavailable", async () => {
      const { provider, mocks, webview, complete, row } = await unreadFixture();
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);
      mocks.history.mockRejectedValue(new Error("history unavailable"));
      await provider.refresh();
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      vi.setSystemTime(completedAtMs + 1);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });

      expect(row().hasUnread).toBe(false);
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("keeps a successful open read even if its follow-up list fails", async () => {
      const { provider, mocks, webview, complete, row } = await unreadFixture();
      await complete(completedAtMs);
      const validList = mocks.list.getMockImplementation()!;
      mocks.list
        .mockClear()
        .mockImplementationOnce(validList)
        .mockRejectedValueOnce(new Error("lookup failed"));
      vi.setSystemTime(completedAtMs + 1);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(row().hasUnread).toBe(false);
      await provider.refresh();
      expect(row().hasUnread).toBe(false);
    });

    it("keeps saved and temporary sessions free of unread icons", async () => {
      const { provider, webview, complete, row, live, temporary } = await unreadFixture();
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);

      temporary.add(activeSessionId);
      await provider.refresh(false);
      expect(row()).toMatchObject({ isInactive: true, state: undefined, hasUnread: false });
      live.delete(activeSessionId);
      await provider.refresh(false);
      expect(row()).toMatchObject({ isInactive: true, state: undefined, hasUnread: false });
      expect(sessionOpenState.update).not.toHaveBeenCalled();

      vi.setSystemTime(completedAtMs + 1);
      await webview.receive({ type: "activateSession", sessionId: activeSessionId });
      expect(row()).toMatchObject({ isInactive: false, state: "waiting-user", hasUnread: false });
    });

    it("discards a stale list query before projecting a newer settlement", async () => {
      const { provider, complete, markCompletion, row, holdRuntimeQuery } = await unreadFixture();
      await complete(completedAtMs, true);
      const held = holdRuntimeQuery();
      const stale = provider.refresh();
      await held.started;

      markCompletion(completedAtMs + 1);
      const latest = provider.refresh();
      held.finish();
      await Promise.all([stale, latest]);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("does not restore a bell from a list projection started before opening", async () => {
      const { provider, mocks, history, webview, complete, row } = await unreadFixture();
      await complete(completedAtMs);
      expect(row().hasUnread).toBe(true);
      const snapshot = await sessionStore.listSessionSnapshot(
        [...history.values()],
        await mocks.list(),
      );
      const held = deferred<typeof snapshot>();
      const project = vi
        .spyOn(sessionStore, "listSessionSnapshot")
        .mockReturnValueOnce(held.promise);
      const refresh = provider.refresh();
      await vi.waitFor(() => expect(project).toHaveBeenCalledOnce());

      vi.setSystemTime(completedAtMs + 1);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await vi.waitFor(() => expect(sessionOpenState.update).toHaveBeenCalledOnce());
      expect(row().hasUnread).toBe(false);
      const messageCount = webview.postMessage.mock.calls.length;
      held.resolve(snapshot);
      await Promise.all([refresh, opening]);
      expect(row().hasUnread).toBe(false);
      for (const [message] of webview.postMessage.mock.calls.slice(messageCount)) {
        if (message.type !== "sessions") continue;
        expect(message.state.groups[0].sessions).toContainEqual(
          expect.objectContaining({ sessionId: activeSessionId, hasUnread: false }),
        );
      }
    });

    it("keeps a newer completion unread while the earlier open time is saving", async () => {
      const { webview, complete, row } = await unreadFixture();
      await complete(completedAtMs);
      const writeStarted = deferred<void>();
      const pendingWrite = deferred<void>();
      sessionOpenState.update.mockImplementationOnce(async (key, openedAtMs) => {
        writeStarted.resolve();
        await pendingWrite.promise;
        sessionOpenState.saved.set(key, openedAtMs);
      });
      vi.setSystemTime(completedAtMs + 1);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      try {
        await writeStarted.promise;
        expect(row().hasUnread).toBe(false);
        await complete(completedAtMs + 2);
        expect(row().hasUnread).toBe(true);
      } finally {
        pendingWrite.resolve();
        await opening;
      }
      expect(row().hasUnread).toBe(true);
      expect([...sessionOpenState.saved.values()]).toEqual([completedAtMs + 1]);

      vi.setSystemTime(completedAtMs + 3);
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(row().hasUnread).toBe(false);
      expect([...sessionOpenState.saved.values()]).toEqual([completedAtMs + 3]);
    });

    it("keeps the read state in memory and logs a storage failure without failing the open", async () => {
      const logError = vi.fn();
      const { provider, webview, complete, row } = await unreadFixture({
        log: { error: logError },
      });
      await complete(completedAtMs);
      sessionOpenState.update.mockRejectedValueOnce(new Error("storage unavailable"));
      vi.setSystemTime(completedAtMs + 1);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await provider.refresh();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("storage unavailable"));
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(row().hasUnread).toBe(false);
    });
  });

  it("resends sessions after the recreated client announces it is ready", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();

    const firstView = createView();
    provider.resolveWebviewView(firstView.view as never);
    await provider.refresh();
    const recreated = createView();
    provider.resolveWebviewView(recreated.view as never);
    await provider.refresh();
    recreated.postMessage.mockClear();

    await recreated.receive({ type: "ready" });

    expect(recreated.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: {
        groups: [
          expect.objectContaining({
            cwd: root,
            sessions: [expect.objectContaining({ sessionId: activeSessionId })],
          }),
        ],
      },
    });
  });

  it("restores the list after SCM hides the view without requiring Refresh", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    webview.setVisible(false);
    webview.postMessage.mockClear();

    webview.setVisible(true);

    await vi.waitFor(() =>
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: "sessions",
        state: { groups: [expect.objectContaining({ cwd: root })] },
      }),
    );
  });

  it("reuses the in-flight initial acquisition when the client becomes ready", async () => {
    const { provider, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    mocks.list.mockClear();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    const ready = webview.receive({ type: "ready" });
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(webview.postMessage.mock.calls.every(([message]) => message.type === "loading")).toBe(
      true,
    );
    held.resolve([{ cwd: root, sessions: [], empty: [] }]);
    await ready;
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.objectContaining({ groups: [expect.objectContaining({ cwd: root })] }),
    });
  });

  it("replays completed success and acquisition errors without another query on ready", async () => {
    const { provider, mocks, webview } = await loadingFixture();
    await webview.receive({ type: "ready" });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
    });
    mocks.list.mockRejectedValueOnce(new Error("list unavailable"));
    await provider.refresh();
    const last = webview.postMessage.mock.lastCall?.[0];
    webview.postMessage.mockClear();
    await webview.receive({ type: "ready" });
    expect(webview.postMessage.mock.calls).toEqual([[last]]);
    expect(last.type).toBe("sessionsError");
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("delivers initial acquisition failure to a ready client", async () => {
    const { provider, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    const ready = webview.receive({ type: "ready" });
    held.reject(new Error("list unavailable"));
    await ready;
    expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "sessionsError" });
  });

  it("serializes overlapping refreshes and discards the superseded reply", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const first = deferred<PiMuxWorkspace[]>();
    const latest = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const oldRefresh = provider.refresh();
    const newRefresh = provider.refresh();
    const ready = webview.receive({ type: "ready" });
    expect(mocks.list).toHaveBeenCalledOnce();
    first.resolve([{ cwd: "/stale", sessions: [], empty: [] }]);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(webview.postMessage.mock.calls.every(([message]) => message.type === "loading")).toBe(
      true,
    );
    latest.resolve([{ cwd: "/latest", sessions: [], empty: [] }]);
    await Promise.all([oldRefresh, newRefresh, ready]);
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.objectContaining({
        groups: [
          expect.objectContaining({ cwd: "/latest" }),
          expect.objectContaining({ cwd: root }),
        ],
      }),
    });
  });

  it("keeps the latest acquisition failure after a superseded successful reply", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise).mockRejectedValueOnce(new Error("latest failure"));
    const oldRefresh = provider.refresh();
    const newRefresh = provider.refresh();
    held.resolve([]);
    await Promise.all([oldRefresh, newRefresh]);
    expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "sessionsError" });
  });

  it("announces the retrieval indicator only for the explicit Refresh action", async () => {
    const { provider, webview } = await loadingFixture();
    webview.postMessage.mockClear();

    await webview.receive({ type: "refresh" });
    await provider.refreshManually();

    expect(loadingMessages(webview)).toEqual([
      { type: "loading", manual: true, displayedSessionId: null },
      { type: "loading", manual: true, displayedSessionId: null },
    ]);
  });

  it("keeps automatic reloads quiet in the status area", async () => {
    const { provider, webview } = await loadingFixture();
    webview.postMessage.mockClear();

    await provider.refresh();
    await provider.refresh(false);

    expect(loadingMessages(webview)).toEqual([
      { type: "loading", manual: false, displayedSessionId: null },
      { type: "loading", manual: false, displayedSessionId: null },
    ]);
  });

  it("keeps watcher-triggered refreshes quiet in the status area", async () => {
    const { provider, webview } = await loadingFixture();
    webview.postMessage.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await provider.onSessionFileChanged();
    await finishHistoryRefresh(provider);
    await finishRefresh(provider);

    expect(loadingMessages(webview)).toEqual([
      { type: "loading", manual: false, displayedSessionId: null },
    ]);
  });

  it("upgrades a queued automatic refresh to the manual indicator", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    webview.postMessage.mockClear();

    const quietRefresh = provider.refresh(false);
    const manualRefresh = webview.receive({ type: "refresh" });
    held.resolve([{ cwd: root, sessions: [], empty: [] }]);
    await Promise.all([quietRefresh, manualRefresh]);

    expect(loadingMessages(webview)).toEqual([
      { type: "loading", manual: false, displayedSessionId: null },
      { type: "loading", manual: true, displayedSessionId: null },
    ]);
  });

  it("keeps an automatic refresh queued behind a manual one quiet", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    webview.postMessage.mockClear();

    const manualRefresh = provider.refreshManually();
    const quietRefresh = provider.refresh(false);
    held.resolve([{ cwd: root, sessions: [], empty: [] }]);
    await Promise.all([manualRefresh, quietRefresh]);

    expect(loadingMessages(webview)).toEqual([
      { type: "loading", manual: true, displayedSessionId: null },
      { type: "loading", manual: false, displayedSessionId: null },
    ]);
  });

  it("announces loading and reports operation errors separately during acquisition", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    const refresh = provider.refresh();
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["loading"]);
    await webview.receive({ type: "addWorkspace", path: "relative" });
    expect(webview.postMessage.mock.lastCall?.[0].type).toBe("error");
    held.resolve([]);
    await refresh;
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "error",
      "sessions",
    ]);
  });

  it("logs the acquisition error and reports the retrieval state without a notification", async () => {
    await seedSavedSession(activeSessionId);
    const { mocks } = sharedRuntimes;
    const registry = createRegistry();
    mocks.list.mockRejectedValue(new Error("lookup failed"));
    const logError = vi.fn();
    const { provider } = createProvider({ registry, log: { error: logError } });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(logError).toHaveBeenCalledWith("Failed to read Pi sessions: lookup failed");
    expect(webview.postMessage.mock.lastCall?.[0]).toEqual({ type: "sessionsError" });
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("logs a hidden-view acquisition failure without a notification or webview post", async () => {
    const { mocks } = sharedRuntimes;
    mocks.list.mockRejectedValue(new Error("lookup failed"));
    const logError = vi.fn();
    const { provider } = createProvider({ log: { error: logError } });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    webview.setVisible(false);
    webview.postMessage.mockClear();

    await provider.refresh();

    expect(logError).toHaveBeenCalledWith("Failed to read Pi sessions: lookup failed");
    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("logs the history read failure and sends the retrieval error state without a notification", async () => {
    sharedRuntimes.mocks.history.mockRejectedValue(new Error("EACCES: permission denied"));
    const logError = vi.fn();
    const { provider } = createProvider({ log: { error: logError } });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(logError).toHaveBeenCalledWith("Failed to read Pi sessions: EACCES: permission denied");
    expect(webview.postMessage.mock.lastCall?.[0]).toEqual({ type: "sessionsError" });
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(false);
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("recovers the mounted client from a dropped provider connection with an unchanged list", async () => {
    const { provider, webview } = await loadingFixture();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("http://localhost/client", (route) =>
        route.fulfill({ contentType: "text/html", body: webviewAppMarkup }),
      );
      await page.goto("http://localhost/client");
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);
      let connected = true;
      webview.postMessage.mockImplementation(async (message) => {
        if (!connected) return false;
        await page.evaluate(
          (message) => window.dispatchEvent(new MessageEvent("message", { data: message })),
          message,
        );
        return true;
      });
      await page.exposeFunction("sendToProvider", async (request: unknown) => {
        if (connected) await webview.receive(request);
      });
      await page.evaluate(() => {
        Object.assign(window, {
          acquireVsCodeApi: () => ({ postMessage: Reflect.get(window, "sendToProvider") }),
        });
      });
      await page.addScriptTag({
        type: "module",
        content: await readFile(join(process.cwd(), "dist-webview/webview/client.js"), "utf8"),
      });
      await expect.poll(() => page.locator(".group-title").count()).toBe(1);
      const names = await page.locator(".session-name").allTextContents();
      connected = false;
      await page.clock.runFor(5000);
      await page.clock.runFor(9999);
      expect(await page.locator("#status").textContent()).toBe("");
      await page.clock.runFor(1);
      await expect
        .poll(() => page.locator("#connection-status").textContent())
        .toContain("Connection lost");
      expect(await page.locator(".session-name").allTextContents()).toEqual(names);
      connected = true;
      await page.clock.runFor(5000);
      await expect.poll(() => page.locator("#connection-status").textContent()).toBe("");
      expect(await page.locator("#status").textContent()).toBe("");
      expect(await page.locator(".session-name").allTextContents()).toEqual(names);
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      await browser.close();
      provider.dispose();
    }
  });

  it("replays correlated success and failure without caching the correlation or querying", async () => {
    const { provider, mocks, webview } = await loadingFixture();
    await webview.receive({ type: "ready", requestId: "connection-success" });
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
      requestId: "connection-success",
    });
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockRejectedValueOnce(new Error("offline"));
    await provider.refresh();
    await webview.receive({ type: "ready", requestId: "connection-error" });
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessionsError",
      requestId: "connection-error",
    });
    await webview.receive({ type: "ready" });
    expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "sessionsError" });
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("answers connection checks immediately during a held acquisition without another query", async () => {
    const { provider, mocks, webview } = await loadingFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    const refreshing = provider.refreshManually();
    await webview.receive({ type: "ready", requestId: "connection-1" });
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "loading",
      manual: true,
      displayedSessionId: null,
      requestId: "connection-1",
    });
    expect(mocks.list).toHaveBeenCalledOnce();
    held.resolve([]);
    await refreshing;
    expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
  });

  it.each(["false", "rejection"])(
    "does not notify when initial loading delivery returns %s",
    async (failure) => {
      const { provider } = createProvider();
      const webview = createView();
      if (failure === "false") webview.postMessage.mockResolvedValueOnce(false);
      else webview.postMessage.mockRejectedValueOnce(new Error("webview gone"));
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    },
  );

  it("reloads the requested live session without changing the display or blocking other requests", async () => {
    const { webview, registry, terminal, mocks } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    terminal.show.mockClear();
    const pending = deferred<void>();
    mocks.reloadSession.mockReturnValueOnce(pending.promise);

    const reload = webview.receive({ type: "reloadSession", sessionId: inactiveSessionId });
    try {
      await webview.receive({ type: "copySessionId", sessionId: inactiveSessionId });
      expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
      expect(mocks.reloadSession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
      expect(registry.displayedSessionId).toBe(activeSessionId);
      expect(terminal.show).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await reload;
    }
  });

  it("does not reload saved-only sessions and reports reload and clipboard errors", async () => {
    const { webview, provider, mocks, live } = await deactivateFixture();
    live.delete(inactiveSessionId);
    await provider.refresh();
    await webview.receive({ type: "reloadSession", sessionId: inactiveSessionId });
    expect(mocks.reloadSession).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(`${inactiveSessionId}: The session is not running`),
    );
    await webview.receive({ type: "copySessionId", sessionId: inactiveSessionId });
    expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);

    mocks.reloadSession.mockRejectedValueOnce(new Error("reload failed"));
    await webview.receive({ type: "reloadSession", sessionId: activeSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(`${activeSessionId}: reload failed`),
    );

    vscodeMocks.clipboardWriteText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await webview.receive({ type: "copySessionId", sessionId: activeSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(`${activeSessionId}: clipboard unavailable`),
    );
  });

  it("hides reload as soon as Deactivate stops the session, before the list refresh", async () => {
    const { webview, mocks } = await deactivateFixture();
    const held = deferred<PiMuxWorkspace[]>();
    mocks.list.mockReturnValueOnce(held.promise);
    webview.postMessage.mockClear();

    const deactivate = webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    try {
      await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith(activeSessionId));
      const state: WebviewState = webview.postMessage.mock.calls.find(
        ([message]) => message.type === "sessions",
      )?.[0].state;
      expect(state.groups[0].sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: activeSessionId, isLive: undefined }),
          expect.objectContaining({ sessionId: inactiveSessionId, isLive: true }),
        ]),
      );
      await webview.receive({ type: "reloadSession", sessionId: activeSessionId });
      expect(mocks.reloadSession).not.toHaveBeenCalled();
    } finally {
      held.resolve(await mocks.list());
      await deactivate;
    }
  });

  it("deactivates the displayed conversation without switching to a live same-cwd session", async () => {
    const { webview, registry, terminal, live, mocks, filePath } = await deactivateFixture();
    const source = await readFile(filePath, "utf8");
    const otherRuntime = live.get(inactiveSessionId);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const startsBefore = mocks.open.mock.calls.length;
    webview.postMessage.mockClear();

    await webview.receive({
      type: "deactivateSession",
      sessionId: activeSessionId,
      target: "arbitrary",
      pid: 1,
    });

    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.get(inactiveSessionId)).toBe(otherRuntime);
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(mocks.switch).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledTimes(startsBefore);
    expect(registry.displayedSessionId).toBeUndefined();
    const publishedSelections = webview.postMessage.mock.calls.map(
      ([message]) => message.state?.displayedSessionId,
    );
    expect(publishedSelections.filter((id) => id !== undefined && id !== activeSessionId)).toEqual(
      [],
    );
    const state: WebviewState = webview.postMessage.mock.calls.at(-1)?.[0].state;
    expect(state.displayedSessionId).toBeUndefined();
    expect(state.groups[0].sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: activeSessionId, isInactive: true }),
        expect.objectContaining({ sessionId: inactiveSessionId, isInactive: false }),
      ]),
    );
    expect(await readFile(filePath, "utf8")).toBe(source);

    await webview.receive({ type: "activateSession", sessionId: activeSessionId });
    expect(mocks.open).toHaveBeenCalledTimes(startsBefore + 1);
    expect(mocks.open).toHaveBeenLastCalledWith({ sessionId: activeSessionId, cwd: root });
  });

  it("does not reopen a tab the user closed before deactivating", async () => {
    const { webview, registry, terminal, live } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    registry.onTerminalClosed(terminal as never);
    const created = vscodeMocks.createTerminal.mock.calls.length;
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(created);
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.has(inactiveSessionId)).toBe(true);
  });

  it("deactivates a background conversation while preserving another display and selection", async () => {
    const { webview, terminal, registry, live, mocks } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.open({ sessionId: inactiveSessionId, cwd: root });
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const otherRuntime = live.get(inactiveSessionId);
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.get(inactiveSessionId)).toBe(otherRuntime);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(inactiveSessionId);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      inactiveSessionId,
    );
  });

  it.each(["confirmed", "lookup retried"] as const)(
    "closes an inactive session's restored tab without switching: %s",
    async (lookup) => {
      const { webview, registry, terminal, mocks, client, live } = await deactivateFixture();
      Object.assign(terminal.creationOptions, {
        env: { PI_SESSIONS_DISPLAY: "1" },
      });
      Object.assign(vscodeMocks.terminals, [terminal]);
      client.attachedId = activeSessionId;
      if (lookup === "lookup retried") {
        mocks.current.mockRejectedValueOnce(new Error("initial client lookup denied"));
      }

      try {
        await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
        expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
        expect(live.has(activeSessionId)).toBe(false);
        expect(live.has(inactiveSessionId)).toBe(true);
        expect(terminal.dispose).toHaveBeenCalledOnce();
        expect(mocks.switch).not.toHaveBeenCalled();
        expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
        expect(registry.displayedSessionId).toBeUndefined();
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        vscodeMocks.terminals.length = 0;
      }
    },
  );

  it("keeps an unrelated restored tab when display lookup fails", async () => {
    const { webview, terminal, mocks, client, live } = await deactivateFixture();
    const restored = terminal;
    Object.assign(restored.creationOptions, {
      env: { PI_SESSIONS_DISPLAY: "1" },
    });
    Object.assign(vscodeMocks.terminals, [restored]);
    client.attachedId = inactiveSessionId;
    mocks.current.mockRejectedValue(new Error("client lookup denied"));
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.has(inactiveSessionId)).toBe(true);

    expect(restored.dispose).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    vscodeMocks.terminals.length = 0;
  });

  it("still calls close before deactivating a stopped session absent from list", async () => {
    const { webview, mocks, live, registry } = await deactivateFixture();
    live.delete(activeSessionId);
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);

    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("rejects a deactivation request for an unknown session id without writing", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "deactivateSession", sessionId: unknownSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
    );
  });

  it.each(["openSession", "activateSession"] as const)(
    "rejects an unknown live session id on %s without writing or creating a session",
    async (type) => {
      await seedSavedSession(activeSessionId);
      const { registry, mocks } = createRuntimeRegistry();
      const { provider, statePath } = createProvider({ registry });

      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      const before = await readFile(statePath, "utf8");

      await webview.receive({ type, sessionId: unknownSessionId });

      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        `Session not found: ${unknownSessionId}`,
      );
      expect(await readFile(statePath, "utf8")).toBe(before);

      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(mocks.aliveSessionIds).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
    },
  );

  it("leaves membership and display unchanged when close fails", async () => {
    const { webview, statePath, mocks, terminal, registry } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    mocks.closeSession.mockRejectedValueOnce(new Error("stop denied"));
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(mocks.switch).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/Failed to stop Pi session .*stop denied/),
    );
  });

  it("sends the deactivate finish message with the request id after the deactivate completes", async () => {
    const { webview } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    webview.postMessage.mockClear();
    await webview.receive({
      type: "deactivateSession",
      sessionId: activeSessionId,
      requestId: "deactivate-1",
    });
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "deactivateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "deactivateFinished", requestId: "deactivate-1" },
    ]);
  });

  it("sends the deactivate finish message when the close fails", async () => {
    const { webview, mocks } = await deactivateFixture();
    mocks.closeSession.mockRejectedValueOnce(new Error("stop denied"));
    await webview.receive({
      type: "deactivateSession",
      sessionId: activeSessionId,
      requestId: "failed-deactivate",
    });
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "deactivateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "deactivateFinished", requestId: "failed-deactivate" },
    ]);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalled();
  });

  it("sends the deactivate finish message when the session is unknown", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await webview.receive({
      type: "deactivateSession",
      sessionId: unknownSessionId,
      requestId: "unknown-deactivate",
    });
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "deactivateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "deactivateFinished", requestId: "unknown-deactivate" },
    ]);
  });

  it("sends the activate finish message with the request id after the display opens", async () => {
    const { webview, mocks } = await deactivateFixture();
    const starts = mocks.open.mock.calls.length;
    await webview.receive({
      type: "activateSession",
      sessionId: activeSessionId,
      requestId: "activate-1",
    });
    expect(mocks.open).toHaveBeenCalledTimes(starts + 1);
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "activateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "activateFinished", requestId: "activate-1" },
    ]);
  });

  it("sends the activate finish message when the open fails", async () => {
    const { webview, mocks } = await deactivateFixture();
    mocks.list.mockRejectedValueOnce(new Error("list failed"));
    await webview.receive({
      type: "activateSession",
      sessionId: activeSessionId,
      requestId: "failed-activate",
    });
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "activateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "activateFinished", requestId: "failed-activate" },
    ]);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalled();
  });

  it("sends the activate finish message when the session is unknown", async () => {
    await seedSavedSession(activeSessionId);
    const { registry } = createRuntimeRegistry();
    const { provider } = createProvider({ registry });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await webview.receive({
      type: "activateSession",
      sessionId: unknownSessionId,
      requestId: "unknown-activate",
    });
    const completions = webview.postMessage.mock.calls.filter(
      ([message]) => message.type === "activateFinished",
    );
    expect(completions.map(([message]) => message)).toEqual([
      { type: "activateFinished", requestId: "unknown-activate" },
    ]);
  });

  it("does not restart Pi or change membership and selection when close fails after Pi exits", async () => {
    const { webview, statePath, mocks, live, terminal, registry } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    const starts = mocks.open.mock.calls.length;
    mocks.closeSession.mockImplementationOnce(async (sessionId) => {
      live.delete(sessionId);
      throw new Error("restore candidate removal failed");
    });
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(mocks.open).toHaveBeenCalledTimes(starts);
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/Failed to stop Pi session .*restore candidate removal failed/),
    );
  });

  it.each([
    { type: "activateSession", previousTemporary: false },
    { type: "activateSession", previousTemporary: true },
    { type: "openSession", previousTemporary: false },
    { type: "openSession", previousTemporary: true },
  ])(
    "restores the previous conversation and reports a failed reconnect: %j",
    async ({ type, previousTemporary }) => {
      const fixture = await unreadFixture();
      const { webview, registry, mocks, live, temporary, provider, complete, row, sentState } =
        fixture;
      if (previousTemporary) temporary.add(activeSessionId);
      live.delete(inactiveSessionId);
      await provider.refresh();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      if (!previousTemporary) await complete(Date.now() + 1);
      const original = live.get(activeSessionId);
      const createsBefore = vscodeMocks.createTerminal.mock.calls.length;
      vscodeMocks.createTerminal.mockImplementationOnce(() => {
        throw new Error("creation denied");
      });
      await webview.receive({ type, sessionId: inactiveSessionId });
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          new RegExp("creation denied; showing previous Pi session " + activeSessionId),
        ),
      );
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("creation denied; showing previous Pi session"),
      });
      expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(createsBefore + 2);
      const restored = await registry.displayForSession(activeSessionId);
      expect(restored).toBeDefined();
      expect(restored?.show).toHaveBeenCalled();
      expect(live.get(activeSessionId)).toBe(original);
      expect(temporary.has(activeSessionId)).toBe(previousTemporary);
      expect(mocks.closeTemporarySession).not.toHaveBeenCalled();
      expect(live.has(inactiveSessionId)).toBe(false);
      const args = vscodeMocks.createTerminal.mock.lastCall?.[0].shellArgs;
      expect(args).toEqual(
        previousTemporary ? ["open", "--temporary", activeSessionId] : ["open", activeSessionId],
      );
      await provider.refresh();
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(row().hasUnread).toBe(!previousTemporary);
      expect(row(inactiveSessionId).isInactive).toBe(true);
    },
  );

  it("reports both reconnect and restoration failures through the existing error paths", async () => {
    const { webview, registry } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    vscodeMocks.createTerminal.mockImplementationOnce(() => {
      throw new Error("creation denied");
    });
    vscodeMocks.createTerminal.mockImplementationOnce(() => {
      throw new Error("restoration denied");
    });
    await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("creation denied; failed to restore display: restoration denied"),
    );
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringContaining(
        "creation denied; failed to restore display: restoration denied",
      ),
    });
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(3);
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(await registry.displayForSession(activeSessionId)).toBeUndefined();
  });

  it.each(["previous", "requested"] as const)(
    "cancels restoration quietly when the %s workspace is unregistered",
    async (workspace) => {
      const fixture = await deactivateFixture();
      const { webview, registry, mocks, live, workspaces, provider } = fixture;
      const other = join(root, "other");
      await mkdir(other);
      workspaces.add(other);
      live.set(inactiveSessionId, { sessionId: inactiveSessionId, cwd: other, target: "pi-other" });
      await seedSavedSession(inactiveSessionId, other, { runtimes: fixture });
      await provider.refresh();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      const snapshot = await mocks.list.getMockImplementation()!();
      const held = deferred<typeof snapshot>();
      const started = vi.fn();
      vscodeMocks.createTerminal.mockImplementationOnce(() => {
        mocks.list.mockImplementationOnce(() => {
          started();
          return held.promise;
        });
        throw new Error("creation denied");
      });
      const opening = webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      const removing = webview.receive({
        type: "unregisterWorkspace",
        cwd: workspace === "previous" ? root : other,
      });
      held.resolve(snapshot);
      await Promise.all([opening, removing]);
      expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(2);
      expect(await registry.displayForSession(activeSessionId)).toBeUndefined();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(webview.postMessage.mock.calls.some(([message]) => message.type === "error")).toBe(
        false,
      );
      expect(mocks.unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(
        workspace === "previous" ? root : other,
      );
    },
  );

  it("activates a requested inactive session, opens it, and refreshes the list", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isInactive).toBe(
      true,
    );

    await webview.receive({ type: "activateSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isInactive: false,
    });
    // the session that just came back from the deactivate opens in the shared terminal
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: homedir() } }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("activates the displayed temporary Pi through normal open without old membership writes", async () => {
    const { runtimes, webview, statePath, registry, terminal } = await inactiveDisplayFixture();
    const before = await readFile(statePath, "utf8");
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.temporary.has(inactiveSessionId)).toBe(true);
    await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
    expect(vscodeMocks.createTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ shellArgs: ["open", inactiveSessionId] }),
    );
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(runtimes.temporary.has(inactiveSessionId)).toBe(false);
    expect(registry.displayedSessionId).toBe(inactiveSessionId);
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(
      webview.postMessage.mock.calls
        .at(-1)?.[0]
        .state.groups[0].sessions.find(
          (row: { sessionId: string }) => row.sessionId === inactiveSessionId,
        ).isInactive,
    ).toBe(false);
  });

  it("activates and reconnects a live session after its saved file disappeared", async () => {
    const { provider, webview, filePath, live, mocks, terminal, registry } =
      await deactivateFixture();

    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isInactive: false,
    });
    const runtime = { sessionId: activeSessionId, cwd: root, target: `pi-${activeSessionId}` };
    live.set(activeSessionId, runtime);
    await rm(filePath);

    await webview.receive({ type: "activateSession", sessionId: activeSessionId });

    expect(mocks.aliveSessionIds).toHaveBeenCalledWith([activeSessionId]);
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(vscodeMocks.createTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        shellPath: "pi-mux",
        shellArgs: ["open", activeSessionId],
      }),
    );
    expect(live.get(activeSessionId)).toBe(runtime);
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(existsSync(filePath)).toBe(false);
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it.each(["absent", "unavailable", "error", "lookup-error"] as const)(
    "keeps old membership unchanged without opening when its saved file disappeared and liveness is %s",
    async (liveness) => {
      const { provider, webview, filePath, mocks, registry } = await deactivateFixture();

      await provider.refresh();
      await rm(filePath);
      if (liveness === "absent") mocks.aliveSessionIds.mockResolvedValue(new Set());
      if (liveness === "unavailable") mocks.aliveSessionIds.mockResolvedValue(null);
      if (liveness === "error") {
        mocks.aliveSessionIds.mockRejectedValueOnce(new Error("pi-mux list failed"));
      }
      if (liveness === "lookup-error") {
        vi.spyOn(sessionStore, "sessionFileExists").mockRejectedValueOnce(
          new Error("lookup failed"),
        );
      }

      await webview.receive({ type: "activateSession", sessionId: activeSessionId });

      if (liveness === "lookup-error") {
        expect(mocks.aliveSessionIds).not.toHaveBeenCalled();
      } else {
        expect(mocks.aliveSessionIds).toHaveBeenCalledWith([activeSessionId]);
      }
      const expectedError =
        liveness === "error"
          ? "Failed to read session file: pi-mux list failed"
          : liveness === "lookup-error"
            ? "Failed to read session file: lookup failed"
            : `Session file no longer exists: ${activeSessionId}`;
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expectedError);
      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBeUndefined();
      expect(existsSync(filePath)).toBe(false);
    },
  );

  it("does not change deactivate display or close the previous Pi when explicit Activate fails", async () => {
    const { runtimes, webview, registry } = await inactiveDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    runtimes.mocks.list.mockRejectedValueOnce(new Error("lookup failed"));
    await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(runtimes.temporary.has(inactiveSessionId)).toBe(true);
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(
      webview.postMessage.mock.calls
        .filter(([message]) => message.type === "sessions")
        .at(-1)?.[0]
        .state.groups[0].sessions.find(
          (row: { sessionId: string }) => row.sessionId === inactiveSessionId,
        ).isInactive,
    ).toBe(true);
  });

  it.each(["deactivateSession", "activateSession", "newSession"] as const)(
    "preserves FIFO around %s when an earlier pending selection is superseded",
    async (type) => {
      const { registry, mocks } = await selectionFixture();
      const run = vi.spyOn(registry, "run");
      const events: string[] = [];
      const open = registry.open.bind(registry);
      vi.spyOn(registry, "open").mockImplementation(async (session) => {
        events.push(`open:${session.sessionId}`);
        return open(session);
      });
      const stop = registry.stop.bind(registry);
      vi.spyOn(registry, "stop").mockImplementation(async (sessionId) => {
        events.push(`stop:${sessionId}`);
        return stop(sessionId);
      });
      const { provider } = createProvider({
        registry,

        startNewSession: async () => {
          await registry.run(async () => {
            events.push("newSession");
          });
          return undefined;
        },
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      const opening = holdNextOpen(mocks);
      const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await opening.started;
      const superseded = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      const operation = webview.receive({ type, sessionId: inactiveSessionId, cwd: root });
      if (type === "newSession") {
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
      }
      const latest = webview.receive({ type: "openSession", sessionId: unknownSessionId });
      opening.finish();
      await Promise.all([first, superseded, operation, latest]);
      const expectedOperation =
        type === "deactivateSession"
          ? `stop:${inactiveSessionId}`
          : type === "activateSession"
            ? `open:${inactiveSessionId}`
            : "newSession";
      expect(events).toEqual([
        `open:${activeSessionId}`,
        expectedOperation,
        `open:${unknownSessionId}`,
      ]);
    },
  );

  it("serializes deactivate and a later All open without forbidding inactive runtimes", async () => {
    const { webview, mocks, live } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    let release!: () => void;
    const pendingStop = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = mocks.closeSession.getMockImplementation()!;
    mocks.closeSession.mockImplementationOnce(async (sessionId) => {
      await pendingStop;
      return stop(sessionId);
    });
    const inactive = webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    const opened = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledTimes(1));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([inactive, opened]);

    expect(live.has(activeSessionId)).toBe(true);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });

  it("reflects disk changes on refresh without automatic updates", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await vi.waitFor(() => {
      expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(true);
    });
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(1);

    await seedSavedSession(inactiveSessionId);
    // No file watcher: the displayed list stays as-is until Refresh arrives.
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);

    await webview.receive({ type: "refresh" });
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(2);
  });

  describe("retained workspace groups", () => {
    beforeEach(() => vi.useFakeTimers());

    async function fixture(
      runtimes = providerRuntimes(),
      workspaceStore: Pick<WorkspaceStore, "list" | "add" | "remove"> = workspaceStorage,
    ) {
      const onWorkspaces = vi.fn();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtimes.mux),
        workspaceStore,
        onWorkspaces,
      });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      function groups(): WebviewState["groups"] {
        return webview.postMessage.mock.calls
          .map(([message]) => message)
          .reverse()
          .find((message) => message.type === "sessions").state.groups;
      }
      return { ...runtimes, provider, webview, groups, onWorkspaces };
    }

    it("persists each discovered cwd once without changing VS Code workspace folders", async () => {
      const { provider, workspaces, groups } = await fixture();
      workspaces.add("/external");
      await tick(provider);
      await tick(provider);
      expect(groups().map(({ cwd }) => cwd)).toEqual(["/external", root]);
      expect(workspaceStorage.add.mock.calls).toEqual([[root], ["/external"]]);
      expect(await workspaceStorage.list()).toEqual(new Set([root, "/external"]));
      expect(vscodeMocks.updateWorkspaceFolders).not.toHaveBeenCalled();
    });

    it("retains headers but drops rows after a successful empty list", async () => {
      const runtime = providerRuntimes();
      await seedSavedSession(activeSessionId, root, { runtimes: runtime });
      const { provider, workspaces, groups, onWorkspaces, mocks } = await fixture(runtime);
      expect(groups()[0].sessions).toHaveLength(1);
      workspaces.clear();
      await tick(provider);
      expect(groups()).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      expect(onWorkspaces).toHaveBeenLastCalledWith([]);
      mocks.history.mockClear();
      await provider.refresh();
      expect(mocks.history).not.toHaveBeenCalled();
      expect(groups()[0].sessions).toEqual([]);
    });

    it("restores retained headers after provider recreation without restoring registration", async () => {
      const original = await fixture();
      original.provider.dispose();
      const runtime = providerRuntimes();
      runtime.workspaces.clear();
      const restored = await fixture(runtime);
      expect(restored.groups()).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      expect(restored.onWorkspaces).toHaveBeenLastCalledWith([]);
      expect(restored.mocks.registerWorkspace).not.toHaveBeenCalled();
      expect(restored.mocks.newSession).not.toHaveBeenCalled();
    });

    it("reads another independent provider's additions and removals from disk", async () => {
      const directory = join(root, "workspace-storage");
      const first = await fixture(providerRuntimes(), new WorkspaceStore(directory));
      const runtime = providerRuntimes();
      runtime.workspaces.clear();
      runtime.workspaces.add("/second");
      const second = await fixture(runtime, new WorkspaceStore(directory));
      await first.provider.refresh(false);
      expect(first.groups().map(({ cwd }) => cwd)).toEqual([root, "/second"]);
      await second.webview.receive({ type: "unregisterWorkspace", cwd: "/second" });
      await first.provider.refresh(false);
      expect(first.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(second.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(await new WorkspaceStore(directory).list()).toEqual(new Set([root]));
    });

    it("opens the default shell in a new editor terminal for a retained-only workspace", async () => {
      const { provider, workspaces, groups, webview, mocks } = await fixture();
      workspaces.clear();
      await tick(provider);
      const previousGroups = groups();
      webview.postMessage.mockClear();
      const show = vi.fn();
      vscodeMocks.createTerminal.mockReturnValue({ show });

      await webview.receive({ type: "openWorkspaceTerminal", cwd: root });

      expect(vscodeMocks.createTerminal).toHaveBeenCalledExactlyOnceWith({
        cwd: { fsPath: root },
        location: 1,
      });
      expect(show).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.unregisterWorkspace).not.toHaveBeenCalled();
      expect(await workspaceStorage.list()).toEqual(new Set([root]));
      expect(previousGroups).toEqual([{ cwd: root, label: expect.any(String), sessions: [] }]);
      expect(webview.postMessage).not.toHaveBeenCalled();
    });

    it.each(["not listed", "missing directory", "file"])(
      "does not open a workspace terminal when the cwd is %s",
      async (problem) => {
        const cwd = join(root, "shell folder");
        if (problem === "not listed") await mkdir(cwd);
        if (problem === "file") await writeFile(cwd, "");
        if (problem !== "not listed") await workspaceStorage.add(cwd);
        const { webview } = await fixture();

        await webview.receive({ type: "openWorkspaceTerminal", cwd });

        expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(cwd));
      },
    );

    it("removes a retained-only cwd through Unregister and adds it again on later registration", async () => {
      const current = await fixture();
      current.workspaces.clear();
      await tick(current.provider);
      await current.webview.receive({ type: "unregisterWorkspace", cwd: root });
      expect(current.mocks.unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(root);
      expect(current.groups()).toEqual([]);
      current.provider.dispose();
      const runtime = providerRuntimes();
      runtime.workspaces.clear();
      const restored = await fixture(runtime);
      expect(restored.groups()).toEqual([]);
      runtime.workspaces.add(root);
      await tick(restored.provider);
      expect(restored.groups().map(({ cwd }) => cwd)).toEqual([root]);
    });

    it("preserves saved workspaces and the previous view when an addition cannot be saved", async () => {
      const current = await fixture();
      workspaceStorage.add.mockRejectedValueOnce(new Error("storage unavailable"));
      current.workspaces.add("/external");
      await tick(current.provider);
      expect(current.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(await workspaceStorage.list()).toContain(root);
      expect(current.webview.postMessage).toHaveBeenCalledWith({ type: "sessionsError" });
      await tick(current.provider);
      expect(current.groups().map(({ cwd }) => cwd)).toEqual(["/external", root]);
    });

    it("keeps a retained header when saving its removal fails", async () => {
      const current = await fixture();
      workspaceStorage.remove.mockRejectedValueOnce(new Error("storage unavailable"));
      await current.webview.receive({ type: "unregisterWorkspace", cwd: root });
      expect(current.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(await workspaceStorage.list()).toContain(root);
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("storage unavailable"),
      );
      await current.webview.receive({ type: "unregisterWorkspace", cwd: root });
      expect(current.groups()).toEqual([]);
    });

    it("finishes an in-flight save before manual removal without reviving a stale group", async () => {
      const current = await fixture();
      const held = deferred<void>();
      const save = workspaceStorage.add.getMockImplementation()!;
      workspaceStorage.add.mockImplementationOnce(async (cwd) => {
        await held.promise;
        await save(cwd);
      });
      current.workspaces.add("/external");
      const refreshing = current.provider.refresh();
      await vi.waitFor(() => expect(workspaceStorage.add).toHaveBeenCalledTimes(2));
      const removing = current.webview.receive({ type: "unregisterWorkspace", cwd: "/external" });
      await vi.waitFor(() => expect(current.mocks.unregisterWorkspace).toHaveBeenCalledOnce());
      held.resolve();
      await Promise.all([refreshing, removing]);
      await tick(current.provider);
      expect(current.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(await workspaceStorage.list()).not.toContain("/external");
    });

    it("keeps the last view when stored workspaces cannot be read", async () => {
      const current = await fixture();
      workspaceStorage.list.mockRejectedValueOnce(new Error("storage unavailable"));
      await tick(current.provider);
      expect(current.groups().map(({ cwd }) => cwd)).toEqual([root]);
      expect(current.webview.postMessage).toHaveBeenCalledWith({ type: "sessionsError" });
      await tick(current.provider);
      expect(current.groups().map(({ cwd }) => cwd)).toEqual([root]);
    });
  });

  describe("workspace CLI operations", () => {
    it("registers the normalized cwd and refreshes list-derived groups", async () => {
      const folder = join(root, "space $literal");
      await mkdir(folder);
      vi.stubEnv("HOME", root);
      const { provider, statePath } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      const before = await readFile(statePath, "utf8");
      await webview.receive({ type: "addWorkspace", path: "~/space $literal/./" });
      expect(sharedRuntimes.mocks.registerWorkspace).toHaveBeenCalledExactlyOnceWith(folder);
      expect(webview.postMessage).toHaveBeenCalledWith({ type: "workspaceAdded" });
      expect(
        webview.postMessage.mock.lastCall?.[0].state.groups.map(
          (group: { cwd: string }) => group.cwd,
        ),
      ).toEqual([root, folder]);
      expect(await readFile(statePath, "utf8")).toBe(before);
    });

    it("registers a saved-history cwd absent from list", async () => {
      const folder = join(root, "history-only");
      await mkdir(folder);
      await seedSavedSession(activeSessionId, folder);
      const { provider } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      await webview.receive({ type: "addWorkspace", path: folder });
      expect(sharedRuntimes.mocks.registerWorkspace).toHaveBeenCalledExactlyOnceWith(folder);
      expect(webview.postMessage.mock.lastCall?.[0].state.groups).toContainEqual(
        expect.objectContaining({
          cwd: folder,
          sessions: [expect.objectContaining({ sessionId: activeSessionId, isInactive: true })],
        }),
      );
    });

    it.each(["relative", "/definitely-missing-workspace"])(
      "rejects invalid workspace input without CLI: %s",
      async (path) => {
        const { provider } = createProvider();
        const webview = createView();
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });
        await webview.receive({ type: "addWorkspace", path });
        expect(sharedRuntimes.mocks.registerWorkspace).not.toHaveBeenCalled();
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining("Invalid workspace path"),
        );
      },
    );

    it("closes the form without invoking CLI or refreshing an already listed cwd", async () => {
      const { provider } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      sharedRuntimes.mocks.list.mockClear();
      await webview.receive({ type: "addWorkspace", path: root + "/./" });
      expect(sharedRuntimes.mocks.registerWorkspace).not.toHaveBeenCalled();
      expect(sharedRuntimes.mocks.list).not.toHaveBeenCalled();
      expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "workspaceAdded" });
    });

    it("closes the form without registering an alias of an already listed workspace", async () => {
      const alias = join(root, "workspace-alias");
      await symlink(root, alias, "junction");
      const { provider } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      sharedRuntimes.mocks.list.mockClear();

      await webview.receive({ type: "addWorkspace", path: alias });

      expect(sharedRuntimes.mocks.registerWorkspace).not.toHaveBeenCalled();
      expect(sharedRuntimes.mocks.list).not.toHaveBeenCalled();
      expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "workspaceAdded" });
    });

    it("does not register an alias when the directory is listed during comparison", async () => {
      vi.useFakeTimers();
      const directory = join(root, "external-workspace");
      const alias = join(root, "external-alias");
      await mkdir(directory);
      await symlink(directory, alias, "junction");
      const { provider } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });

      let releaseComparison!: () => void;
      const comparisonHeld = new Promise<void>((resolve) => {
        releaseComparison = resolve;
      });
      const comparison = vi
        .spyOn(workDirectory, "sameWorkDirectory")
        .mockImplementationOnce(async () => {
          await comparisonHeld;
          return false;
        });
      const adding = webview.receive({ type: "addWorkspace", path: alias });
      try {
        await vi.waitFor(() => expect(comparison).toHaveBeenCalledWith(root, alias));
        sharedRuntimes.workspaces.add(directory);
        await tick(provider);
        sharedRuntimes.mocks.list.mockClear();
      } finally {
        releaseComparison();
        await adding;
      }

      expect(sharedRuntimes.mocks.registerWorkspace).not.toHaveBeenCalled();
      expect(sharedRuntimes.mocks.list).not.toHaveBeenCalled();
      expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "workspaceAdded" });
    });

    it("registers a new workspace even when a listed workspace no longer exists", async () => {
      sharedRuntimes.workspaces.add(join(root, "missing-workspace"));
      const folder = join(root, "new-workspace");
      await mkdir(folder);
      const { provider } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });

      await webview.receive({ type: "addWorkspace", path: folder });

      expect(sharedRuntimes.mocks.registerWorkspace).toHaveBeenCalledExactlyOnceWith(folder);
    });

    it("preserves the form and input by withholding success when registration fails", async () => {
      const folder = join(root, "new-workspace");
      await mkdir(folder);
      const { provider, statePath } = createProvider();
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      webview.postMessage.mockClear();
      sharedRuntimes.mocks.list.mockClear();
      sharedRuntimes.mocks.registerWorkspace.mockRejectedValueOnce(new Error("register denied"));
      await webview.receive({ type: "addWorkspace", path: folder });
      expect(webview.postMessage).toHaveBeenCalledExactlyOnceWith({
        type: "error",
        message: expect.stringContaining("register denied"),
      });
      expect(sharedRuntimes.mocks.list).not.toHaveBeenCalled();
      expect(sharedRuntimes.workspaces.has(folder)).toBe(false);
      expect(await readFile(statePath, "utf8")).toBe("invalid legacy JSON sentinel");
    });

    it("delegates same-cwd stopping and unregister to CLI then refreshes without changing saved files", async () => {
      const { provider, webview, mocks, live, workspaces, filePath, statePath } =
        await deactivateFixture();
      const other = join(root, "other");
      workspaces.add(other);
      live.set("other", { sessionId: "other", cwd: other, target: "other-target" });
      const source = await readFile(filePath, "utf8");
      await webview.receive({ type: "unregisterWorkspace", cwd: root });
      expect(mocks.unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(root);
      expect(mocks.closeSession).not.toHaveBeenCalled();
      expect(live.has(activeSessionId)).toBe(false);
      expect(live.has("other")).toBe(true);
      expect(
        webview.postMessage.mock.lastCall?.[0].state.groups.map(
          (group: { cwd: string }) => group.cwd,
        ),
      ).toEqual([other]);
      expect(await readFile(filePath, "utf8")).toBe(source);
      expect(await readFile(statePath, "utf8")).toBe("invalid legacy JSON sentinel");
      provider.dispose();
    });

    it.each(["openSession", "activateSession"])(
      "cancels a pending %s quietly when its workspace is unregistered",
      async (type) => {
        const { webview, mocks, terminal, registry } = await deactivateFixture();
        const held = deferred<Awaited<ReturnType<PiMux["list"]>>>();
        mocks.list.mockReturnValueOnce(held.promise);
        const opening = webview.receive({ type, sessionId: activeSessionId });
        await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
        const queued = webview.receive({
          type: "activateSession",
          sessionId: inactiveSessionId,
          requestId: "cancelled-activate",
        });
        const removing = webview.receive({ type: "unregisterWorkspace", cwd: root });
        held.resolve([]);
        await Promise.all([opening, queued, removing]);
        expect(mocks.unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(root);
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
        expect(webview.postMessage.mock.calls.some(([message]) => message.type === "error")).toBe(
          false,
        );
        const completions = webview.postMessage.mock.calls.filter(
          ([message]) => message.type === "activateFinished",
        );
        expect(completions.map(([message]) => message)).toEqual([
          { type: "activateFinished", requestId: "cancelled-activate" },
        ]);
        expect(terminal.show).not.toHaveBeenCalled();
        expect(registry.displayedSessionId).toBeUndefined();
        expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      },
    );

    it("finishes unregister before a late attachment reply without restoring the display", async () => {
      const { webview, mocks, terminal, registry } = await deactivateFixture();
      await registry.open({ sessionId: inactiveSessionId, cwd: root });
      const held = deferred<Awaited<ReturnType<PiMux["current"]>>>();
      mocks.current.mockReturnValueOnce(held.promise);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
      await webview.receive({ type: "unregisterWorkspace", cwd: root });
      await opening;
      expect(terminal.dispose).not.toHaveBeenCalled();
      held.resolve({ id: inactiveSessionId, cwd: root, file: "/late.jsonl", target: "late" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mocks.switch).not.toHaveBeenCalled();
      expect(terminal.show).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBe(inactiveSessionId);
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(webview.postMessage.mock.calls.some(([message]) => message.type === "error")).toBe(
        false,
      );
    });

    it("keeps an attaching open when another workspace is unregistered", async () => {
      const { webview, mocks, terminal, registry, workspaces } = await deactivateFixture();
      await registry.open({ sessionId: inactiveSessionId, cwd: root });
      const other = join(root, "other");
      workspaces.add(other);
      const held = deferred<Awaited<ReturnType<PiMux["current"]>>>();
      mocks.current.mockReturnValueOnce(held.promise);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
      const removing = webview.receive({ type: "unregisterWorkspace", cwd: other });
      held.resolve({ id: activeSessionId, cwd: root, file: "/attached.jsonl", target: "attached" });
      await Promise.all([opening, removing]);
      expect(terminal.show).toHaveBeenCalledOnce();
      expect(registry.displayedSessionId).toBe(activeSessionId);
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("reports a terminal closing during attachment without an unregister request", async () => {
      const { webview, mocks, terminal, registry } = await deactivateFixture();
      await registry.open({ sessionId: inactiveSessionId, cwd: root });
      const held = deferred<Awaited<ReturnType<PiMux["current"]>>>();
      mocks.current.mockReturnValueOnce(held.promise);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
      registry.onTerminalClosed(terminal as never);
      await opening;
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Pi display closed during attachment"),
      );
      expect(webview.postMessage.mock.calls.some(([message]) => message.type === "error")).toBe(
        true,
      );
      held.resolve(undefined);
    });

    it("cancels a queued open before it creates a display", async () => {
      const { webview, registry } = await deactivateFixture();
      const held = deferred<void>();
      const blocking = registry.run(() => held.promise);
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      const removing = webview.receive({ type: "unregisterWorkspace", cwd: root });
      held.resolve();
      await Promise.all([blocking, opening, removing]);
      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("reports unregister failure after cancelling the attaching open", async () => {
      const { webview, mocks, registry } = await deactivateFixture();
      await registry.open({ sessionId: inactiveSessionId, cwd: root });
      const held = deferred<Awaited<ReturnType<PiMux["current"]>>>();
      mocks.current.mockReturnValueOnce(held.promise);
      mocks.unregisterWorkspace.mockRejectedValueOnce(new Error("unregister denied"));
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
      await webview.receive({ type: "unregisterWorkspace", cwd: root });
      await opening;
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
        `Failed to unregister workspace ${root}: unregister denied`,
      );
      expect(webview.postMessage.mock.lastCall?.[0]).toEqual({
        type: "error",
        message: `Failed to unregister workspace ${root}: unregister denied`,
      });
      held.resolve(undefined);
    });

    it("retains the registered group without restart or refresh after unregister fails", async () => {
      const { webview, mocks, live, workspaces } = await deactivateFixture();
      const groups = webview.postMessage.mock.lastCall?.[0].state.groups;
      mocks.list.mockClear();
      mocks.unregisterWorkspace.mockImplementationOnce(async () => {
        live.delete(activeSessionId);
        throw new Error("unregister denied after stop");
      });
      await webview.receive({ type: "unregisterWorkspace", cwd: root });
      expect(workspaces.has(root)).toBe(true);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(webview.postMessage.mock.lastCall?.[0]).toEqual({
        type: "error",
        message: expect.stringContaining("unregister denied after stop"),
      });
      const lastGroups = webview.postMessage.mock.calls
        .filter(([message]) => message.type === "sessions")
        .at(-1)?.[0].state.groups;
      expect(lastGroups).toEqual(groups);
    });
  });

  it("launches the requested group cwd for the new session", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    await seedSavedSession(inactiveSessionId);
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "newSession", cwd: root });

    expect(startNewSession).toHaveBeenCalledWith(root, expect.any(Function));
  });

  it("shows the immediately active new session as selected after its saved fixture arrives and is refreshed", async () => {
    const cwdDir = join(root, "sessions");
    await writeJsonl(cwdDir, "old.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const statePath = join(root, "session-state.json");

    const { mocks, live, client } = providerRuntimes();
    const historyEntries: PiMuxHistoryEntry[] = [
      {
        id: inactiveSessionId,
        cwd: root,
        file: join(cwdDir, "old.jsonl"),
        title: null,
        btime: 1,
        mtime: 1,
        size: 1,
        source: "normal",
      },
    ];
    const fakePiMuxCommand = vi.fn(async (executable: string, args: string[], cwd?: string) => {
      expect(executable).toBe("pi-mux");
      if (args.join(" ") === "new --detached") {
        expect(cwd).toBe(root);
        mocks.open({ sessionId: activeSessionId, cwd: root });
        return `Pi session ${activeSessionId}\nAttach with: pi-mux open ${activeSessionId}\n`;
      }
      if (args.join(" ") === "list --active --json") {
        return JSON.stringify([
          {
            cwd: root,
            sessions: [...live.values()]
              .filter(({ sessionId }) => historyEntries.some(({ id }) => id === sessionId))
              .map((runtime) => ({
                id: runtime.sessionId,
                file: join(cwdDir, `2024-12-03_${runtime.sessionId}.jsonl`),
                state: null,
                title: null,
              })),
            empty: [...live.values()]
              .filter(({ sessionId }) => !historyEntries.some(({ id }) => id === sessionId))
              .map((runtime) => ({
                id: runtime.sessionId,
                file: join(cwdDir, `2024-12-03_${runtime.sessionId}.jsonl`),
              })),
          },
        ]);
      }
      if (args.join(" ") === "list --json") return combinedHistoryOutput(root, historyEntries);
      if (args.join(" ") === "list --displayed --json --client-pid 123") {
        const runtime = client.attachedId === undefined ? undefined : live.get(client.attachedId);
        if (runtime === undefined) return "[]";
        return JSON.stringify([
          {
            clientPid: client.pid,
            id: runtime.sessionId,
            cwd: runtime.cwd,
            file: join(cwdDir, `2024-12-03_${runtime.sessionId}.jsonl`),
            target: runtime.target,
          },
        ]);
      }
      throw new Error(`Unexpected pi-mux command: ${args.join(" ")}`);
    });
    const registry = new TerminalRegistry(editorTerminals(), new PiMux(fakePiMuxCommand));
    const terminal = { processId: Promise.resolve(123), show: vi.fn(), dispose: vi.fn() };
    vscodeMocks.createTerminal.mockImplementation(() => {
      mocks.open({ sessionId: activeSessionId, cwd: root });
      return terminal;
    });
    const launcher = new SessionLauncher({
      registry,
      onSessionStarted: () => provider.refresh(),
    });
    const { provider } = createProvider({
      registry,
      startNewSession: (cwd) => launcher.start(cwd),
    });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await webview.receive({ type: "ready" });

    function sentState(): WebviewState {
      const message = webview.postMessage.mock.calls.at(-1)?.[0] as
        | { type: string; state?: WebviewState }
        | undefined;
      if (message?.type !== "sessions" || message.state === undefined) {
        throw new Error("Expected the latest message to contain refreshed sessions");
      }
      return message.state;
    }

    function renderedRows(state: WebviewState): ElementDescriptor[] {
      return sessionListView(state, new Map(), state.displayedSessionId)
        .sessions.flatMap((group) => group.children ?? [])
        .filter(
          (child): child is ElementDescriptor =>
            typeof child !== "string" &&
            (child.attrs?.class ?? "").split(" ").includes("session-row"),
        );
    }

    expect(renderedRows(sentState())).toEqual([]);
    await webview.receive({ type: "newSession", cwd: root });

    expect(fakePiMuxCommand.mock.calls.some(([, args]) => args[0] === "new")).toBe(false);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        shellPath: "pi-mux",
        shellArgs: ["new", "--cwd", root],
      }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(sentState().displayedSessionId).toBe(activeSessionId);
    expect(sentState().groups[0].sessions.map((session) => session.sessionId)).toEqual([
      inactiveSessionId,
    ]);
    expect(renderedRows(sentState())).toHaveLength(0);
    expect(historyEntries).toHaveLength(1);
    const activeStoreBeforeSave = await readFile(statePath, "utf8");

    const savedFixture = await writeJsonl(cwdDir, `2024-12-03_${activeSessionId}.jsonl`, [
      header({ id: activeSessionId, cwd: root }),
      messageEntry("user", [{ type: "text", text: "Saved fixture conversation" }]),
    ]);
    const savedContents = await readFile(savedFixture, "utf8");
    historyEntries.push({
      id: activeSessionId,
      cwd: root,
      file: savedFixture,
      title: "Saved fixture conversation",
      btime: 1,
      mtime: 2,
      size: savedContents.length,
      source: "normal",
    });
    await webview.receive({ type: "refresh" });

    const refreshed = sentState();
    expect(refreshed.displayedSessionId).toBe(activeSessionId);
    expect(refreshed.groups[0].sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: activeSessionId,
          displayName: "Saved fixture conversation",
          isInactive: false,
        }),
        expect.objectContaining({ sessionId: inactiveSessionId, isInactive: true }),
      ]),
    );
    const rows = renderedRows(refreshed);
    expect(rows).toHaveLength(1);
    expect(rows[0].attrs?.class).toBe("session-row selected");
    expect(rows[0].children?.[0]).toEqual(
      expect.objectContaining({
        attrs: expect.objectContaining({ "data-session": activeSessionId }),
      }),
    );

    expect(await readFile(statePath, "utf8")).toBe(activeStoreBeforeSave);
    expect(await readFile(savedFixture, "utf8")).toBe(savedContents);
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    launcher.dispose();
    provider.dispose();
  });

  it("displays a launch error without changing the list", async () => {
    const startNewSession = vi.fn().mockRejectedValue(new Error("Work folder missing"));
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsBefore = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await webview.receive({ type: "newSession", cwd: root });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Failed to start Pi session in ${root}: Work folder missing`,
    );
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsBefore);
  });

  it.each([false, true])(
    "opens only the latest pending row without interrupting the running selection (inactive=%s)",
    async (inactive) => {
      const fixture = await selectionFixture();
      const { webview, mocks, registry, statePath, provider, shown, filePath } = fixture;

      if (inactive) fixture.live.clear();
      else {
        fixture.live.set(unknownSessionId, {
          sessionId: unknownSessionId,
          cwd: root,
          target: `pi-${unknownSessionId}`,
        });
      }
      await provider.refresh();
      const before = await readFile(statePath, "utf8");
      const opening = holdNextOpen(mocks);
      const open = vi.spyOn(registry, "open");
      const validateFile = vi.spyOn(sessionStore, "sessionFileExists");
      const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
      await opening.started;
      const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      const third = webview.receive({ type: "openSession", sessionId: unknownSessionId });
      expect(shown).toEqual([]);
      expect(mocks.open).not.toHaveBeenCalled();
      opening.finish();
      await Promise.all([first, second, third]);

      expect(open.mock.calls.map(([session]) => session.sessionId)).toEqual([
        activeSessionId,
        unknownSessionId,
      ]);
      expect(mocks.open.mock.calls.map(([session]) => session.sessionId)).toEqual(
        inactive ? [activeSessionId, unknownSessionId] : [activeSessionId],
      );
      expect(shown).toEqual([activeSessionId, unknownSessionId]);
      expect(validateFile.mock.calls.map(([path]) => path)).toEqual([
        filePath,
        join(root, "sessions", `${unknownSessionId}.jsonl`),
      ]);
      const displayed = webview.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === "sessions")
        .map((message) => message.state.displayedSessionId);
      expect(displayed).not.toContain(inactiveSessionId);
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      expect(await readFile(statePath, "utf8")).toBe(before);
    },
  );

  it.each([
    ["openSession", "empty"],
    ["openSession", "different file"],
    ["activateSession", "missing"],
    ["activateSession", "different file"],
  ] as const)(
    "does not reopen a delayed live-only %s if the open-time Active shows %s",
    async (type, replacement) => {
      const runtimes = providerRuntimes();
      await seedSavedSession(activeSessionId, root, { runtimes });
      const selectedFile = await writeJsonl(join(root, "archive"), "selected.jsonl", [
        header({ id: activeSessionId, cwd: root }),
      ]);
      runtimes.live.set(activeSessionId, {
        sessionId: activeSessionId,
        cwd: root,
        target: "pi-selected",
      });
      runtimes.files.set(activeSessionId, selectedFile);
      if (type === "activateSession") runtimes.temporary.add(activeSessionId);
      const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
      const terminal = {
        processId: Promise.resolve(123),
        creationOptions: {},
        show: vi.fn(),
        dispose: vi.fn(),
      };
      mockTerminal(runtimes, terminal, registry, root);
      await registry.open({ sessionId: inactiveSessionId, cwd: root });
      vscodeMocks.createTerminal.mockClear();
      const { provider } = createProvider({ registry });
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await webview.receive({ type: "ready" });
      const state: WebviewState | undefined = webview.postMessage.mock.lastCall?.[0].state;
      const rows = state?.groups.flatMap(({ sessions }) => sessions);
      expect(rows?.find(({ sessionId }) => sessionId === activeSessionId)).toMatchObject({
        isInactive: type === "activateSession",
        isLive: true,
      });

      const requested = deferred<string>();
      const continueOpen = deferred<undefined>();
      runtimes.mocks.viewTarget.mockImplementationOnce(async (_id, file) => {
        requested.resolve(file);
        return continueOpen.promise;
      });
      runtimes.mocks.list.mockClear();
      const selection = webview.receive({ type, sessionId: activeSessionId });
      expect(await requested.promise).toBe(selectedFile);
      expect(runtimes.mocks.list).not.toHaveBeenCalled();
      if (replacement === "empty") runtimes.emptyIds.add(activeSessionId);
      else if (replacement === "missing") runtimes.live.delete(activeSessionId);
      else runtimes.files.set(activeSessionId, join(root, "replacement.jsonl"));
      continueOpen.resolve(undefined);
      await selection;
      await finishRefresh(provider);

      expect(runtimes.mocks.list).toHaveBeenCalled();
      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(runtimes.mocks.switch).not.toHaveBeenCalled();
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(terminal.show).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBe(inactiveSessionId);
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("no longer running that file"),
      );
    },
  );

  it("coalesces again while the previous latest selection is running", async () => {
    const { webview, registry, shown } = await selectionFixture();
    const open = registry.open.bind(registry);
    const openSpy = vi.spyOn(registry, "open");
    function holdSelection() {
      const gate = deferred<void>();
      const started = deferred<void>();
      openSpy.mockImplementationOnce(async (session) => {
        started.resolve();
        await gate.promise;
        return open(session);
      });
      return { started: started.promise, finish: () => gate.resolve() };
    }
    const firstOpening = holdSelection();
    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await firstOpening.started;
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const third = webview.receive({ type: "openSession", sessionId: unknownSessionId });
    const thirdOpening = holdSelection();
    firstOpening.finish();
    await thirdOpening.started;
    expect(shown).toEqual([activeSessionId]);
    const fourth = webview.receive({ type: "openSession", sessionId: activeSessionId });
    const fifth = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    thirdOpening.finish();
    await Promise.all([first, second, third, fourth, fifth]);
    expect(shown).toEqual([activeSessionId, unknownSessionId, inactiveSessionId]);
  });

  it("skips a superseded invalid selection and continues after the running open fails", async () => {
    const { webview, mocks, shown } = await selectionFixture();
    const opening = holdNextOpen(mocks);
    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await opening.started;
    const invalid = webview.receive({ type: "openSession", sessionId: "missing-session" });
    const latest = webview.receive({ type: "openSession", sessionId: unknownSessionId });
    vscodeMocks.createTerminal.mockImplementationOnce(() => {
      throw new Error("Terminal creation failed");
    });
    opening.finish();
    await Promise.all([first, invalid, latest]);
    expect(shown).toEqual([unknownSessionId]);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Terminal creation failed"),
    );
  });

  it("processes a running selection and the next selection in arrival order", async () => {
    const terminal = {
      creationOptions: { cwd: { fsPath: root } },
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    await seedSavedSession(inactiveSessionId, root, { runtimes });
    const { mocks, live } = runtimes;
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    live.set(inactiveSessionId, {
      sessionId: inactiveSessionId,
      cwd: root,
      target: `pi-${inactiveSessionId}`,
    });
    mockTerminal(runtimes, terminal, registry, root);
    let finishOpening: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    mocks.list.mockClear();
    mocks.list.mockImplementationOnce(async () => {
      await opening;
      return [
        {
          cwd: root,
          sessions: [...live.values()].map((runtime) => ({
            id: runtime.sessionId,
            file: "/saved/session.jsonl",
            state: null,
            title: null,
          })),
          empty: [],
        },
      ];
    });

    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    finishOpening();
    await Promise.all([first, second]);

    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.show).toHaveBeenCalledTimes(2);
  });

  it.each(["process ID", "pending current", "failing current"] as const)(
    "shows a new Terminal and completes selection without waiting for %s",
    async (blocked) => {
      const fixture = await unreadFixture();
      const { webview, terminal, mocks, registry, complete, row, sentState } = fixture;
      await complete();
      expect(row().hasUnread).toBe(true);
      const pid = deferred<number>();
      const current = deferred<Awaited<ReturnType<PiMux["current"]>>>();
      const readPid = vi.fn(() => (blocked === "process ID" ? pid.promise : Promise.resolve(123)));
      Object.defineProperty(terminal, "processId", { get: readPid });
      if (blocked === "failing current") mocks.current.mockRejectedValue(new Error("no client"));
      else mocks.current.mockReturnValueOnce(current.promise);
      let completed = false;
      const opening = webview
        .receive({ type: "openSession", sessionId: activeSessionId })
        .then(() => {
          completed = true;
        });
      try {
        await vi.waitFor(
          () => {
            expect(terminal.show).toHaveBeenCalledOnce();
            expect(completed).toBe(true);
          },
          { timeout: 500 },
        );
        expect(registry.displayedSessionId).toBe(activeSessionId);
        expect(sentState().displayedSessionId).toBe(activeSessionId);
        expect(row().hasUnread).toBe(false);
        expect(readPid).toHaveBeenCalledOnce();
        expect(terminal.show.mock.invocationCallOrder[0]).toBeLessThan(
          readPid.mock.invocationCallOrder[0],
        );
        expect(mocks.current).not.toHaveBeenCalled();
        expect(mocks.switch).not.toHaveBeenCalled();
        expect(terminal.dispose).not.toHaveBeenCalled();
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        pid.resolve(123);
        current.resolve(undefined);
        await opening;
      }
    },
  );

  it("records the pre-display response only after the client confirms the session", async () => {
    const { webview, terminal, mocks } = await unreadFixture();
    const confirmation = deferred<Awaited<ReturnType<PiMux["current"]>>>();
    const target = { file: "/saved/A.jsonl", fileIdentity: "1:2:3", responseId: "shown-response" };
    mocks.viewTarget.mockResolvedValue(target);
    mocks.current.mockReturnValueOnce(confirmation.promise);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(terminal.show).toHaveBeenCalled();
    expect(mocks.viewTarget.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.show.mock.invocationCallOrder[0],
    );
    expect(mocks.recordView).not.toHaveBeenCalled();
    mocks.viewTarget.mockResolvedValue({ ...target, responseId: "response-arrived-after-show" });
    confirmation.resolve({
      id: activeSessionId,
      cwd: root,
      file: "/saved/A.jsonl",
      target: "pi-A",
    });
    await vi.waitFor(() =>
      expect(mocks.recordView).toHaveBeenCalledExactlyOnceWith(
        activeSessionId,
        target,
        expect.any(Number),
      ),
    );
    expect(mocks.viewTarget).toHaveBeenCalledOnce();
  });

  it("does not record history when the newly shown terminal fails to attach", async () => {
    const logError = vi.fn();
    const { webview, mocks } = await unreadFixture({ log: { error: logError } });
    mocks.viewTarget.mockResolvedValue({
      file: "/saved/A.jsonl",
      fileIdentity: "1:2:3",
      responseId: "shown-response",
    });
    mocks.current.mockRejectedValueOnce(new Error("no client"));

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(expect.stringContaining("no client")),
    );
    expect(mocks.recordView).not.toHaveBeenCalled();
    expect(sessionOpenState.update).toHaveBeenCalledOnce();
  });

  it("does not let a late confirmation supersede a later view of the same session", async () => {
    const { webview, registry, mocks } = await unreadFixture();
    const firstConfirm = deferred<boolean>();
    const confirmation = vi
      .spyOn(registry, "confirmSessionDisplay")
      .mockResolvedValue(true)
      .mockReturnValueOnce(firstConfirm.promise);
    const oldTarget = { file: "/saved/A.jsonl", fileIdentity: "1:2:3", responseId: "older" };
    const newTarget = { ...oldTarget, responseId: "newer" };
    mocks.viewTarget.mockResolvedValueOnce(oldTarget);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    mocks.viewTarget.mockResolvedValueOnce(newTarget);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(confirmation).toHaveBeenCalledTimes(2);
    firstConfirm.resolve(true);
    await firstConfirm.promise;
    await Promise.resolve();
    expect(mocks.recordView).toHaveBeenCalledExactlyOnceWith(
      activeSessionId,
      newTarget,
      expect.any(Number),
    );
  });

  it("does not open saved history whose header cwd is outside list workspaces", async () => {
    const cwd = join(root, "missing");
    await seedSavedSession(inactiveSessionId, cwd);
    const { provider } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();

    expect(sharedRuntimes.workspaces).toEqual(new Set([root]));
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(`Session not found: ${inactiveSessionId}`),
    );
  });

  it("refreshes a vanished switch target and keeps the current display", async () => {
    const { webview, provider, registry, terminal, live, mocks, sentState, row } =
      await unreadFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(row(inactiveSessionId).isInactive).toBe(false);
    mocks.history.mockClear();
    mocks.switch.mockImplementationOnce(async () => {
      live.delete(inactiveSessionId);
      return "target-missing";
    });

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    await finishRefresh(provider);

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(`Pi session ${inactiveSessionId} is no longer running`),
    );
    expect(mocks.switch).toHaveBeenCalledExactlyOnceWith(inactiveSessionId, 123);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(sentState().displayedSessionId).toBe(activeSessionId);
    expect(row(inactiveSessionId).isInactive).toBe(true);
  });

  it("opens a live session when its saved session file disappeared", async () => {
    const runtimes = providerRuntimes();
    const filePath = await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await rm(filePath);
    runtimes.live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "pi-mux",
        shellArgs: ["open", "--temporary", activeSessionId],
      }),
    );
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(existsSync(filePath)).toBe(false);
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it.each(["absent", "unavailable", "error", "lookup-error"] as const)(
    "does not open or create a session when its saved file disappeared and liveness is %s",
    async (liveness) => {
      const { webview, statePath, filePath, mocks, registry } = await deactivateFixture();
      const before = await readFile(statePath, "utf8");
      await rm(filePath);
      if (liveness === "absent") mocks.aliveSessionIds.mockResolvedValue(new Set());
      if (liveness === "unavailable") mocks.aliveSessionIds.mockResolvedValue(null);
      if (liveness === "error") {
        mocks.aliveSessionIds.mockRejectedValueOnce(new Error("pi-mux list failed"));
      }
      if (liveness === "lookup-error") {
        vi.spyOn(sessionStore, "sessionFileExists").mockRejectedValueOnce(
          new Error("lookup failed"),
        );
      }

      await webview.receive({ type: "openSession", sessionId: activeSessionId });

      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBeUndefined();
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(existsSync(filePath)).toBe(false);
      const expectedError =
        liveness === "error"
          ? "Failed to read session file: pi-mux list failed"
          : liveness === "lookup-error"
            ? "Failed to read session file: lookup failed"
            : `Session file no longer exists: ${activeSessionId}`;
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expectedError);
    },
  );

  it("rejects a live list session whose cwd has disappeared without changing old membership", async () => {
    const runtime = providerRuntimes();
    const missing = join(root, "missing");
    const file = await writeJsonl(join(root, "files"), "saved.jsonl", [
      header({ id: activeSessionId, cwd: missing }),
    ]);
    runtime.live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: missing,
      target: "live-target",
    });
    runtime.files.set(activeSessionId, file);
    const { provider, statePath } = createProvider({
      registry: new TerminalRegistry(editorTerminals(), runtime.mux),
    });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await webview.receive({ type: "ready" });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to open session ${activeSessionId} in ${missing}:`),
    );
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe("invalid legacy JSON sentinel");
  });

  it("keeps the row inactive when opening a saved conversation temporarily", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isInactive).toBe(
      true,
    );

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isInactive).toBe(
      true,
    );
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ shellArgs: ["open", "--temporary", activeSessionId] }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("opens saved history temporarily and reuses its editor terminal", async () => {
    await seedSavedSession(activeSessionId);
    const terminal = {
      creationOptions: { cwd: { fsPath: root } },
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const { registry, mocks } = createRuntimeRegistry();
    mockTerminal(sharedRuntimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: homedir() },
        location: 1,
        shellPath: "pi-mux",
        shellArgs: ["open", "--temporary", activeSessionId],
      }),
    );
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith({
      sessionId: activeSessionId,
      cwd: root,
      temporary: true,
    });
    expect(terminal.show).toHaveBeenCalledTimes(2);
  });

  it.each(["list", "switch"] as const)(
    "keeps inactive metadata unchanged when the pi-mux %s command fails",
    async (method) => {
      const runtimes = providerRuntimes();
      await seedSavedSession(inactiveSessionId, root, { runtimes });
      const { mocks, live } = runtimes;
      const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
      const terminal = { processId: Promise.resolve(123), show: vi.fn(), dispose: vi.fn() };
      terminal.dispose.mockImplementation(() => registry.onTerminalClosed(terminal as never));
      vscodeMocks.createTerminal.mockReturnValue(terminal);
      const { provider, statePath } = createProvider({ registry });

      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      const before = await readFile(statePath, "utf8");
      if (method === "list") {
        mocks.list.mockRejectedValueOnce(new Error("pi-mux permission denied"));
      } else {
        live.set(inactiveSessionId, {
          sessionId: inactiveSessionId,
          cwd: root,
          target: `pi-${inactiveSessionId}`,
        });
        await registry.open({ sessionId: activeSessionId, cwd: root });
        Object.defineProperty(terminal, "creationOptions", { value: {} });
        mocks.current.mockResolvedValueOnce({
          id: activeSessionId,
          cwd: root,
          file: `/saved/${activeSessionId}.jsonl`,
          target: "different-target",
        });
        mocks.switch.mockRejectedValueOnce(new Error("pi-mux permission denied"));
      }

      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(inactiveSessionId),
      );
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(root));
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("pi-mux permission denied"),
      );
      expect(terminal.show).not.toHaveBeenCalled();
    },
  );

  it("reflects list promotion without sending state or updating old membership", async () => {
    const { runtimes, webview, provider, statePath } = await inactiveDisplayFixture();
    const before = await readFile(statePath, "utf8");
    runtimes.temporary.delete(inactiveSessionId);
    runtimes.phases.set(inactiveSessionId, "running");
    await provider.refresh();
    const row = webview.postMessage.mock.calls
      .at(-1)?.[0]
      .state.groups[0].sessions.find(
        (row: { sessionId: string }) => row.sessionId === inactiveSessionId,
      );
    expect(row).toMatchObject({ isInactive: false, state: "running" });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(runtimes.mocks.open).not.toHaveBeenCalled();
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
  });

  it("stops an inactive previous display when the shared display moves away", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture();

    // opening the inactive session keeps its tmux session alive while displayed
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // switching to the active session stops the inactive one
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
    expect(runtimes.live.has(activeSessionId)).toBe(true);

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("stops an inactive previous display when a new session replaces it", async () => {
    const newSessionId = "00000000-0000-4000-8000-000000000003";
    const { registry, runtimes, webview } = await inactiveDisplayFixture({
      startNewSession: async () =>
        registry.run(async () => {
          const previous = registry.displayedSessionId;
          runtimes.mocks.open({ sessionId: newSessionId, cwd: root });
          await registry.open({ sessionId: newSessionId, cwd: root });
          return previous;
        }),
    });

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "newSession", cwd: root });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
  });

  it("preserves a promoted previous Pi when conditional close skips it after a switch", async () => {
    const { runtimes, webview, registry } = await inactiveDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const open = registry.open.bind(registry);
    vi.spyOn(registry, "open").mockImplementationOnce(async (session, intent) => {
      const result = await open(session, intent);
      runtimes.temporary.delete(inactiveSessionId);
      return result;
    });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
    expect(runtimes.mocks.closeSession).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("keeps normal Pi and unrelated temporary Pi when selecting another normal Pi", async () => {
    const { runtimes, webview, registry } = await inactiveDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
    const external = "external-temporary";
    runtimes.live.set(external, { sessionId: external, cwd: root, target: "external" });
    runtimes.temporary.add(external);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
    expect(runtimes.live.has(external)).toBe(true);
    expect(registry.displayedSessionId).toBe(activeSessionId);
  });

  it("keeps a session that came back from the deactivate alive when the display moves away", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });

    expect(runtimes.temporary.has(inactiveSessionId)).toBe(false);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("does not stop the inactive display when it is selected again", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the inactive display when switching to the other session fails", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // the switch target lost its session file: the open fails and the
    // display stays on the inactive session, which must stay alive
    await rm(join(root, "sessions", `${activeSessionId}.jsonl`));
    runtimes.live.delete(activeSessionId);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the inactive display when starting a new session fails", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture({
      startNewSession: async () => {
        throw new Error("Work folder missing");
      },
    });

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "newSession", cwd: root });
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Failed to start Pi session in ${root}: Work folder missing`,
    );
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the inactive display when a failed launch closed the shared display", async () => {
    const { registry, runtimes, terminal, webview } = await inactiveDisplayFixture({
      startNewSession: async () => {
        // a failed launch closed the old display tab before its attach failed
        registry.onTerminalClosed(terminal as never);
        throw new Error("cannot attach to tmux session");
      },
    });

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "newSession", cwd: root });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("reports the failure but keeps the new display when stopping the inactive display fails", async () => {
    const { runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    runtimes.mocks.closeTemporarySession.mockRejectedValueOnce(new Error("pi-mux close failed"));

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Failed to close temporary Pi session ${inactiveSessionId}: pi-mux close failed`,
    );
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("restores saved history as inactive despite old active membership after workspace reload", async () => {
    await seedSavedSession(activeSessionId);
    const original = createProvider();

    original.provider.dispose();
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    const restored = createProvider({ registry });
    const webview = createView();
    restored.provider.resolveWebviewView(webview.view as never);
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    mockTerminal(runtimes, terminal, registry, root);

    await webview.receive({ type: "ready" });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toEqual([
      expect.objectContaining({ sessionId: activeSessionId, isInactive: true }),
    ]);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("does not read old membership when refreshing", async () => {
    const { provider, statePath, webview } = await loadingFixture();
    await writeFile(statePath, "invalid json");
    await provider.refresh();
    expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
    expect(await readFile(statePath, "utf8")).toBe("invalid json");
  });

  it("keeps legacy attributes unchanged when only refreshing the list", async () => {
    await seedSavedSession(activeSessionId);
    const { provider, statePath } = createProvider();
    const original = JSON.stringify({
      "active-workspaces": {
        [root]: {
          "active-sessions": { [activeSessionId]: { lock: true, state: "running", note: "keep" } },
        },
      },
    });
    await writeFile(statePath, original);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await webview.receive({ type: "refresh" });
    expect(await readFile(statePath, "utf8")).toBe(original);
  });

  it("ignores invalid old metadata when acquiring the list", async () => {
    await seedSavedSession(activeSessionId);
    const statePath = join(root, "session-state.json");
    await writeFile(statePath, "{ invalid", "utf8");
    const { provider } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(true);
  });

  it("serves the client module from dist-webview with a random base64 nonce", async () => {
    const { provider } = createProvider();
    const webview = createView();

    provider.resolveWebviewView(webview.view as never);

    expect(webview.view.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [{ fsPath: `${root}/dist-webview` }],
    });
    const html = webview.view.webview.html;
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(html).toContain(`src="vscode-webview://test${root}/dist-webview/webview/client.js"`);
  });

  it("deactivates without rewriting legacy locks or unrelated attributes", async () => {
    await seedSavedSession(activeSessionId);
    const { provider, statePath } = createProvider();
    await writeFile(
      statePath,
      JSON.stringify({
        "active-workspaces": {
          [root]: {
            "active-sessions": {
              [activeSessionId]: { lock: true },
              [inactiveSessionId]: { lock: true, state: "running", note: "keep" },
            },
          },
        },
        tags: ["keep"],
      }),
    );
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const before = await readFile(statePath, "utf8");
    const row = webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0];
    expect(row.isInactive).toBe(true);
    expect(row).not.toHaveProperty("isLocked");

    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isInactive).toBe(
      true,
    );
  });

  it.each(["missing", "invalid"] as const)(
    "performs Activate and Deactivate with %s old JSON",
    async (kind) => {
      const { runtimes, webview, statePath, registry } = await inactiveDisplayFixture();
      if (kind === "missing") await rm(statePath);
      else await writeFile(statePath, "invalid JSON");
      await webview.receive({ type: "activateSession", sessionId: inactiveSessionId });
      expect(registry.displayedSessionId).toBe(inactiveSessionId);
      expect(runtimes.temporary.has(inactiveSessionId)).toBe(false);
      await webview.receive({ type: "deactivateSession", sessionId: inactiveSessionId });
      expect(runtimes.mocks.closeSession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
      expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
      expect(runtimes.live.has(inactiveSessionId)).toBe(false);
      expect(registry.displayedSessionId).toBeUndefined();
      if (kind === "missing") expect(existsSync(statePath)).toBe(false);
      else expect(await readFile(statePath, "utf8")).toBe("invalid JSON");
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    },
  );

  it("activates a live Pi even when the old store directory is read-only", async () => {
    const { webview, statePath, registry, mocks } = await deactivateFixture();
    const before = await readFile(statePath, "utf8");
    await chmod(root, 0o500);
    try {
      await webview.receive({ type: "activateSession", sessionId: activeSessionId });
      expect(registry.displayedSessionId).toBe(activeSessionId);
      expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ shellArgs: ["open", activeSessionId] }),
      );
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(mocks.closeSession).not.toHaveBeenCalled();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("deactivates without consulting invalid old membership", async () => {
    const { webview, statePath, mocks, live } = await deactivateFixture();
    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe("{ invalid");
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("deactivates successfully without writing into a read-only old-store directory", async () => {
    const { webview, statePath, mocks, live, registry } = await deactivateFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    await chmod(root, 0o500);
    try {
      await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(live.has(activeSessionId)).toBe(false);
      expect(registry.displayedSessionId).toBeUndefined();
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
      expect(mocks.closeTemporarySession).not.toHaveBeenCalled();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("rejects an unknown session but does not gate close on invalid old membership", async () => {
    const { webview, statePath, mocks } = await deactivateFixture();
    const before = await readFile(statePath, "utf8");
    await webview.receive({ type: "deactivateSession", sessionId: unknownSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "deactivateSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it("closes the previous temporary Pi even when old membership is invalid", async () => {
    const { statePath, runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await writeFile(statePath, "not json", "utf8");
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe("not json");
  });

  it("stops the inactive display when the store file is missing", async () => {
    const { statePath, runtimes, webview } = await inactiveDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await rm(statePath);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledWith(inactiveSessionId);
  });

  it("opens an unregistered cwd directly in Pi without workbench side effects", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: homedir() } }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.getWorkspaceFolder).not.toHaveBeenCalled();
    expect(vscodeMocks.updateWorkspaceFolders).not.toHaveBeenCalled();
    expect(vscodeMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
    expect(vscodeMocks.getExtension).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("starts a new session only when the fixed protocol requests it", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "newSession", cwd: root });
    await webview.receive({ type: "shell", command: "pi" });

    expect(startNewSession).toHaveBeenCalledTimes(1);
    expect(startNewSession).toHaveBeenCalledWith(root, expect.any(Function));
  });

  it.each([
    { type: "setSessionLock", sessionId: activeSessionId, locked: true },
    { type: "setSessionLock", sessionId: activeSessionId, locked: false },
  ])("ignores removed $type requests without effects", async (request) => {
    const { provider, statePath } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const before = await readFile(statePath, "utf8");
    const messagesBefore = webview.postMessage.mock.calls.length;

    await webview.receive(request);

    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(webview.postMessage).toHaveBeenCalledTimes(messagesBefore);
    expect(vscodeMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
  });
});

describe("session status indicators", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  function sentState(webview: { postMessage: Mock }): WebviewState {
    const message = webview.postMessage.mock.calls
      .map((call) => call[0])
      .reverse()
      .find((message) => message.type === "sessions") as { state: WebviewState } | undefined;
    if (message === undefined) throw new Error("no session state was sent");
    return message.state;
  }

  function row(webview: { postMessage: Mock }, sessionId = activeSessionId) {
    const session = sentState(webview)
      .groups.flatMap((group) => group.sessions)
      .find((item) => item.sessionId === sessionId);
    if (session === undefined) throw new Error(`session row missing: ${sessionId}`);
    return session;
  }

  /** Overlays `publishPending` on the active session of the base list mock.
   * `undefined` removes the mark to simulate a resolved publication. */
  function overlayPublishPending(
    runtimes: ReturnType<typeof fakeRuntimes>,
    attemptAt: () => number | undefined,
  ): void {
    const baseList = runtimes.mocks.list.getMockImplementation()!;
    runtimes.mocks.list.mockImplementation(async () => {
      const workspaces = await baseList();
      const pendingAt = attemptAt();
      return workspaces.map((workspace) => ({
        ...workspace,
        sessions: workspace.sessions.map((session) =>
          session.id === activeSessionId
            ? pendingAt === undefined
              ? { ...session, publishPending: null }
              : { ...session, publishPending: { attemptAt: pendingAt } }
            : session,
        ),
      }));
    });
  }

  it("shows a row as delayed while publishPending is fresh and clears it when it resolves", async () => {
    const fixture = await deactivateFixture();
    overlayPublishPending(fixture, () => Date.now() - 1_000);
    await fixture.provider.refresh();
    expect(row(fixture.webview)).toMatchObject({ publishDelayed: true });

    overlayPublishPending(fixture, () => undefined);
    await fixture.provider.refresh();
    expect(row(fixture.webview)).toMatchObject({ publishDelayed: false });
  });

  it("hides the mark for an attempt older than the freshness window", async () => {
    const fixture = await deactivateFixture();
    overlayPublishPending(fixture, () => Date.now() - 11_000);
    await fixture.provider.refresh();
    expect(row(fixture.webview)).toMatchObject({ publishDelayed: false });
  });

  it("keeps an inactive row delayed like an active row", async () => {
    const fixture = await deactivateFixture();
    fixture.temporary.add(activeSessionId);
    overlayPublishPending(fixture, () => Date.now() - 1_000);
    await fixture.provider.refresh();
    expect(row(fixture.webview)).toMatchObject({ isInactive: true, publishDelayed: true });
  });

  it.each([false, true])(
    "updates reload waiting through the list poll and keeps it on failure (inactive: %s)",
    async (isInactive) => {
      const fixture = await deactivateFixture();
      if (isInactive) fixture.temporary.add(activeSessionId);
      fixture.phases.set(activeSessionId, "running");
      overlayPublishPending(fixture, () => Date.now());
      const { mocks, provider, webview } = fixture;
      const readList = mocks.list.getMockImplementation()!;
      let isReloadPending = false;
      mocks.list.mockImplementation(async () =>
        (await readList()).map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.map((session) =>
            isReloadPending && session.id === activeSessionId
              ? { ...session, reloadStatus: "waiting-reload" }
              : session,
          ),
          empty: [
            ...workspace.empty,
            {
              id: unknownSessionId,
              file: join(root, "not-yet-saved.jsonl"),
              reloadStatus: "waiting-reload",
            },
          ],
        })),
      );
      await tick(provider);
      expect(row(webview)).not.toHaveProperty("reloadPending");
      mocks.list.mockClear();
      mocks.history.mockClear();

      isReloadPending = true;
      await tick(provider);
      expect(row(webview)).toMatchObject({
        isInactive,
        publishDelayed: true,
        reloadPending: true,
        state: isInactive ? undefined : "running",
      });
      expect(row(webview, inactiveSessionId)).not.toHaveProperty("reloadPending");
      expect(
        sentState(webview).groups.flatMap((group) =>
          group.sessions.map(({ sessionId }) => sessionId),
        ),
      ).not.toContain(unknownSessionId);
      expect(mocks.list).toHaveBeenCalledOnce();
      expect(mocks.history).not.toHaveBeenCalled();

      mocks.list.mockRejectedValueOnce(new Error("list unavailable"));
      await tick(provider);
      expect(webview.postMessage).toHaveBeenLastCalledWith({ type: "sessionsError" });
      expect(row(webview).reloadPending).toBe(true);

      isReloadPending = false;
      await tick(provider);
      expect(row(webview)).not.toHaveProperty("reloadPending");
      expect(mocks.list).toHaveBeenCalledTimes(3);
      expect(mocks.history).not.toHaveBeenCalled();
    },
  );

  it("re-evaluates a stale attempt without any list change", async () => {
    const fixture = await deactivateFixture();
    const attemptAt = Date.now() - 500;
    overlayPublishPending(fixture, () => attemptAt);
    await fixture.provider.refresh();
    expect(row(fixture.webview)).toMatchObject({ publishDelayed: true });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(attemptAt + 11_000);
    try {
      await tick(fixture.provider);
      expect(row(fixture.webview)).toMatchObject({ publishDelayed: false });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
