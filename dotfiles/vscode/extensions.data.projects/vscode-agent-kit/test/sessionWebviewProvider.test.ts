import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionLauncher } from "../src/launcher";
import { EmptySessionPool } from "../src/emptySessionPool";
import * as workDirectory from "../src/workDirectory";
import { PiMux, type PiMuxHistoryEntry, type PiMuxWorkspace } from "../src/piMux";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { fakeRuntimes } from "./runtimeFixtures";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
import * as sessionStore from "../src/sessionStore";
import type { SessionPhase, WebviewState } from "../src/webview/protocol";
import { sessionListView, type ElementDescriptor } from "../src/webview/client";
import { cleanup, header, messageEntry, tempDir, writeJsonl } from "./fixtures";
const vscodeMocks = vi.hoisted(() => ({
  terminals: [],
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
const emptyPools: EmptySessionPool[] = [];
let sharedRuntimes: ReturnType<typeof providerRuntimes>;

beforeEach(async () => {
  root = await tempDir("pi-webview-provider-test-");
  vi.resetAllMocks();
  sharedRuntimes = providerRuntimes();
  historySeedCount = 0;
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  for (const pool of emptyPools.splice(0)) pool.dispose();
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

async function tick(provider: SessionWebviewProvider, milliseconds = 1000) {
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

/** Saved-session fixture: write the conversation file and register it as a
 * `pi-mux history` entry so the list and file-existence checks see it. */
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
  });
  return filePath;
}

function mockTerminal(
  mocks: ReturnType<typeof fakeRuntimes>["mocks"],
  terminal: object,
  registry: TerminalRegistry,
  openCwd: string,
): void {
  let created = false;
  vscodeMocks.createTerminal.mockImplementation((options) => {
    const sessionId = options.shellArgs?.at(-1);
    if (typeof sessionId === "string") {
      mocks.open({
        sessionId,
        cwd: openCwd,
        ...(options.shellArgs.includes("--temporary") ? { temporary: true as const } : {}),
      });
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
    registry: createRegistry(),
    startNewSession: async () => undefined,
    ...deps,
  } as ConstructorParameters<typeof SessionWebviewProvider>[0]);
  providers.push(provider);
  return { provider, statePath };
}

async function archiveFixture() {
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
  mockTerminal(runtimes.mocks, terminal, registry, root);
  const { provider, statePath } = createProvider({ registry });

  const webview = createView();
  provider.resolveWebviewView(webview.view as never);
  await provider.refresh();
  return { ...runtimes, registry, terminal, provider, statePath, webview, filePath };
}

async function unreadFixture() {
  const fixture = await archiveFixture();
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
  return { ...fixture, setPhase, sentState, row, holdRuntimeQuery };
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
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessionsError",
      message: "Failed to read Pi sessions: list unavailable",
    });
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
      state: expect.objectContaining({ groups: [expect.objectContaining({ cwd: "/latest" })] }),
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
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessionsError",
      message: "Failed to read Pi sessions: latest failure",
    });
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

  it("does not read old membership when refreshing", async () => {
    const { provider, statePath, webview } = await loadingFixture();
    await writeFile(statePath, "invalid json");
    await provider.refresh();
    expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
    expect(await readFile(statePath, "utf8")).toBe("invalid json");
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

  it("sends unregistered sessions as unarchived and archived ones from metadata, then archives on request", async () => {
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
        isArchived: boolean;
      }[];
    expect(
      sentSessions()
        .map((session) => [session.sessionId, session.isArchived])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ).toEqual([
      [activeSessionId, false],
      [inactiveSessionId, true],
    ]);

    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });

    expect(
      sentSessions().find((session) => session.sessionId === activeSessionId)?.isArchived,
    ).toBe(true);
  });

  it("archives without rewriting legacy locks or unrelated attributes", async () => {
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
    expect(row.isArchived).toBe(true);
    expect(row).not.toHaveProperty("isLocked");

    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );
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

  it("rejects an archive request for an unknown session id without writing", async () => {
    await seedSavedSession(activeSessionId);
    const { provider } = createProvider();

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "archiveSession", sessionId: unknownSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
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

  it("reports an acquisition error when the initial pi-mux query fails", async () => {
    await seedSavedSession(activeSessionId);
    const { mocks, live } = sharedRuntimes;
    const registry = createRegistry();
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    mocks.list.mockRejectedValue(new Error("lookup failed"));
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("lookup failed"),
    );
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
      if (args[0] === "history")
        return JSON.stringify([sharedRuntimes.history.get(activeSessionId)]);
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
    expect(execute).toHaveBeenCalledWith("pi-mux", ["list"], undefined);
    expect(await readFile(statePath, "utf8")).toBe(savedState);
  });

  describe("automatic list refresh", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

    it("updates membership, title, workspace and phases every second without JSON writes", async () => {
      const fixture = await unreadFixture();
      const { provider, phases, titles, live, workspaces, row, statePath, mocks, sentState } =
        fixture;
      const original = await readFile(statePath, "utf8");
      mocks.list.mockClear();
      phases.set(activeSessionId, "running");
      titles.set(activeSessionId, "Live title");
      workspaces.add("/new-empty");
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.list).not.toHaveBeenCalled();
      await tick(provider, 1);
      expect(row()).toMatchObject({ state: "running", displayName: "Live title" });
      expect(sentState().groups.some(({ cwd }) => cwd === "/new-empty")).toBe(true);
      phases.set(activeSessionId, "waiting-user");
      await tick(provider);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      live.delete(activeSessionId);
      await tick(provider);
      expect(row()).toMatchObject({ isArchived: true, state: undefined, hasUnread: false });
      expect(await readFile(statePath, "utf8")).toBe(original);
    });

    it("retries after initial and later failures without replacing the last list", async () => {
      const { provider, mocks, webview } = await loadingFixture();
      mocks.list.mockRejectedValueOnce(new Error("offline"));
      await provider.refresh();
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      await tick(provider);
      expect(webview.postMessage.mock.lastCall?.[0].type).toBe("sessions");
      const { row, setPhase, phases, mocks: runtimeMocks, provider: other } = await unreadFixture();
      await setPhase("running");
      runtimeMocks.list.mockRejectedValueOnce(new Error("offline"));
      phases.set(activeSessionId, "waiting-user");
      await tick(other);
      expect(row()).toMatchObject({ state: "running", hasUnread: false });
      await tick(other);
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("continues list acquisition while hidden without JSONL reads or UI delivery", async () => {
      const { provider, webview, mocks, phases, row } = await unreadFixture();
      const scan = vi.spyOn(sessionStore, "listSessionSnapshot");
      mocks.list.mockClear();
      webview.postMessage.mockClear();
      webview.setVisible(false);
      phases.set(activeSessionId, "running");
      await tick(provider);
      await tick(provider);
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(scan).not.toHaveBeenCalled();
      expect(webview.postMessage).not.toHaveBeenCalled();
      phases.set(activeSessionId, "waiting-user");
      webview.setVisible(true);
      await webview.receive({ type: "ready" });
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

    it("publishes cwd snapshots for prewarming even before a webview exists", async () => {
      const runtime = providerRuntimes();
      const onWorkspaces = vi.fn();
      const { provider } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), runtime.mux),
        onWorkspaces,
      });
      await provider.refresh();
      expect(onWorkspaces).toHaveBeenLastCalledWith([root]);
      runtime.workspaces.add("/added");
      await tick(provider);
      expect(onWorkspaces).toHaveBeenLastCalledWith([root, "/added"]);
      runtime.mocks.list.mockRejectedValueOnce(new Error("offline"));
      await tick(provider);
      expect(onWorkspaces).toHaveBeenCalledTimes(2);
    });

    it("waits for a slow query before scheduling the next interval", async () => {
      const { provider, mocks, holdRuntimeQuery } = await unreadFixture();
      mocks.list.mockClear();
      const held = holdRuntimeQuery();
      await vi.advanceTimersByTimeAsync(1000);
      await held.started;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.list).toHaveBeenCalledOnce();
      held.finish();
      await finishRefresh(provider);
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.list).toHaveBeenCalledOnce();
      await tick(provider, 1);
      expect(mocks.list).toHaveBeenCalledTimes(2);
    });

    it.each(["view", "provider"])("drops replies after %s disposal", async (target) => {
      const { provider, webview, mocks, holdRuntimeQuery } = await unreadFixture();
      const held = holdRuntimeQuery();
      mocks.list.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      await held.started;
      if (target === "view") webview.dispose();
      else provider.dispose();
      webview.postMessage.mockClear();
      held.finish();
      await finishRefresh(provider);
      await tick(provider);
      expect(webview.postMessage).not.toHaveBeenCalled();
      expect(mocks.list).toHaveBeenCalledTimes(target === "view" ? 2 : 1);
    });

    it("rejects a pre-hide response and publishes a newly requested snapshot", async () => {
      const { provider, webview, phases, row, holdRuntimeQuery } = await unreadFixture();
      phases.set(activeSessionId, "running");
      const held = holdRuntimeQuery();
      await vi.advanceTimersByTimeAsync(1000);
      await held.started;
      webview.setVisible(false);
      phases.set(activeSessionId, "waiting-approval");
      webview.setVisible(true);
      const ready = webview.receive({ type: "ready" });
      held.finish();
      await ready;
      await finishRefresh(provider);
      expect(row().state).toBe("waiting-approval");
    });
  });

  describe("unread completion", () => {
    it("treats an initially idle session as read", async () => {
      const { row } = await unreadFixture();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("marks a background run complete once and preserves unread across refreshes", async () => {
      const { provider, setPhase, row, statePath, filePath } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      const savedState = await readFile(statePath, "utf8");
      const savedSession = await readFile(filePath, "utf8");

      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row().hasUnread).toBe(true);
      expect(await readFile(statePath, "utf8")).toBe(savedState);
      expect(await readFile(filePath, "utf8")).toBe(savedSession);
    });

    it("does not infer a completed run from approval alone", async () => {
      const { setPhase, row } = await unreadFixture();
      await setPhase("waiting-approval");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(false);
    });

    it("remembers the observed run through its approval phase", async () => {
      const { setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-approval");
      expect(row()).toMatchObject({ state: "waiting-approval", hasUnread: false });
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
    });

    it("clears the previous completion when a new run starts", async () => {
      const { setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      await setPhase("running");
      expect(row()).toMatchObject({ state: "running", hasUnread: false });
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
    });

    it("marks the session read when opening it and keeps it read after switching away", async () => {
      const { webview, setPhase, row, sentState } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(row().hasUnread).toBe(false);

      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      expect(sentState().displayedSessionId).toBe(inactiveSessionId);
      expect(row().hasUnread).toBe(false);
    });

    it.each([true, false])(
      "preserves a displayed completion across refreshes with the list visible=%s",
      async (visible) => {
        const { provider, webview, registry, terminal, setPhase, row } = await unreadFixture();
        await webview.receive({ type: "openSession", sessionId: activeSessionId });
        webview.setVisible(visible);
        await setPhase("running");
        await setPhase("waiting-user");
        if (!visible) {
          webview.setVisible(true);
          await webview.receive({ type: "ready" });
        }
        expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });

        await provider.refresh();
        expect(row().hasUnread).toBe(true);
        registry.onTerminalClosed(terminal as never);
        await provider.refresh();
        expect(row().hasUnread).toBe(true);
      },
    );

    it("acknowledges a displayed completion when the same session is selected again", async () => {
      const { provider, webview, setPhase, row, sentState } = await unreadFixture();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(sentState().displayedSessionId).toBe(activeSessionId);
      expect(row().hasUnread).toBe(false);
      await provider.refresh();
      expect(row().hasUnread).toBe(false);
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
    });

    it.each([false, true])(
      "does not acknowledge a completion when opening fails with displayed=%s",
      async (displayed) => {
        const { provider, mocks, webview, setPhase, row } = await unreadFixture();
        if (displayed) {
          await webview.receive({ type: "openSession", sessionId: activeSessionId });
        }
        await setPhase("running");
        await setPhase("waiting-user");
        mocks.list.mockRejectedValueOnce(new Error("cannot attach"));

        await webview.receive({ type: "openSession", sessionId: activeSessionId });
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining("cannot attach"),
        );
        expect(row().hasUnread).toBe(true);
        await provider.refresh();
        expect(row().hasUnread).toBe(true);
      },
    );

    it("keeps completion tracking and unread when the webview is recreated", async () => {
      const { provider, setPhase, sentState } = await unreadFixture();
      await setPhase("running");
      const replacement = createView();
      provider.resolveWebviewView(replacement.view as never);
      await replacement.receive({ type: "ready" });
      await setPhase("waiting-user");
      expect(
        sentState(replacement).groups[0].sessions.find(
          (session) => session.sessionId === activeSessionId,
        )?.hasUnread,
      ).toBe(true);

      const nextView = createView();
      provider.resolveWebviewView(nextView.view as never);
      await nextView.receive({ type: "ready" });
      expect(
        sentState(nextView).groups[0].sessions.find(
          (session) => session.sessionId === activeSessionId,
        )?.hasUnread,
      ).toBe(true);
    });

    it("starts read after recreating the extension provider over the same saved state", async () => {
      const { provider, mux, setPhase, row, sentState } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      provider.dispose();

      const { provider: replacement } = createProvider({
        registry: new TerminalRegistry(editorTerminals(), mux),
      });
      const replacementView = createView();
      replacement.resolveWebviewView(replacementView.view as never);
      await replacementView.receive({ type: "ready" });
      expect(
        sentState(replacementView).groups[0].sessions.find(
          (session) => session.sessionId === activeSessionId,
        )?.hasUnread,
      ).toBe(false);
    });

    it("preserves a displayed completion when switching away during its runtime query", async () => {
      const { provider, webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("running");
      const held = holdRuntimeQuery();
      const completion = setPhase("waiting-user");
      await held.started;

      const opening = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      held.finish();
      await opening;
      await completion;
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row().hasUnread).toBe(true);
    });

    it.each(["running", "completed"] as const)(
      "keeps a newer %s run when an older open phase query finishes",
      async (newerRun) => {
        const { mocks, webview, phases, setPhase, row, holdRuntimeQuery } = await unreadFixture();
        await setPhase("running");
        await setPhase("waiting-user");
        const list = mocks.list.getMockImplementation()!;
        mocks.list.mockImplementationOnce(list);
        const held = holdRuntimeQuery();
        const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
        try {
          await held.started;
          await setPhase("running");
          if (newerRun === "completed") await setPhase("waiting-user");
          else phases.set(activeSessionId, "waiting-user");
        } finally {
          held.finish();
          await opening;
        }
        expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      },
    );

    it.each(["same-completion", "other-session"] as const)(
      "acknowledges the selected completion after a concurrent %s refresh",
      async (refreshKind) => {
        const { provider, mocks, webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
        await setPhase("running");
        await setPhase("waiting-user");
        const list = mocks.list.getMockImplementation()!;
        mocks.list.mockImplementationOnce(list);
        const held = holdRuntimeQuery();
        const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
        try {
          await held.started;
          if (refreshKind === "other-session") await setPhase("running", inactiveSessionId);
          else await provider.refresh();
        } finally {
          held.finish();
          await opening;
        }
        expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
      },
    );

    it("does not let a delayed displayed completion clear a newer background completion", async () => {
      const { webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("running");
      const held = holdRuntimeQuery();
      const oldCompletion = setPhase("waiting-user");
      await held.started;

      const opening = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      held.finish();
      await opening;
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      await oldCompletion;
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("does not let a delayed background completion undo a successful open acknowledgement", async () => {
      const { webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await setPhase("running");
      const held = holdRuntimeQuery();
      const completion = setPhase("waiting-user");
      await held.started;

      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      held.finish();
      await opening;
      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      await completion;
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("consumes a completion acknowledged before its runtime query finishes", async () => {
      const { provider, mocks, webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("running");
      const held = holdRuntimeQuery();
      const completion = setPhase("waiting-user");
      await held.started;
      const sessions = await mocks.list();
      mocks.list
        .mockResolvedValueOnce(sessions)
        .mockResolvedValueOnce(sessions)
        .mockRejectedValueOnce(new Error("lookup failed"));
      // hold the held refresh's history read: with a real CLI it costs a
      // subprocess, keeping the refresh behind the open acknowledgement
      const history = mocks.history.getMockImplementation()!;
      let releaseHistory!: () => void;
      const historyGate = new Promise<void>((resolve) => {
        releaseHistory = resolve;
      });
      mocks.history.mockImplementationOnce(async () => {
        await historyGate;
        return history();
      });

      const historyCalls = mocks.history.mock.calls.length;
      const opening = webview.receive({ type: "openSession", sessionId: activeSessionId });
      held.finish();
      await vi.waitFor(() => expect(mocks.history.mock.calls.length).toBe(historyCalls + 1));
      releaseHistory();
      await opening;
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        "Failed to read Pi sessions: lookup failed",
      );
      expect(row().hasUnread).toBe(false);
      await completion;
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("keeps tracking a running session selected during a transient pi-mux query failure", async () => {
      const { mocks, webview, setPhase, row } = await unreadFixture();
      await setPhase("running");
      const sessions = await mocks.list();
      mocks.list.mockResolvedValueOnce(sessions).mockRejectedValueOnce(new Error("lookup failed"));

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      await setPhase("waiting-user");
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("preserves unread through a transient pi-mux query failure until recovery", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);

      mocks.list.mockRejectedValueOnce(new Error("lookup failed"));
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("preserves an observed run when its completion cannot yet be checked against pi-mux", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      mocks.list.mockRejectedValueOnce(new Error("lookup failed"));
      await setPhase("waiting-user");
      expect(row().state).toBe("running");

      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it.each(["missing-phase", "not-listed"] as const)(
      "forgets a run and unread after %s rather than notifying again",
      async (reason) => {
        const { provider, live, setPhase, row } = await unreadFixture();
        await setPhase("running");
        await setPhase("waiting-user");
        expect(row().hasUnread).toBe(true);

        if (reason === "missing-phase") await setPhase(undefined);
        if (reason === "not-listed") {
          live.delete(activeSessionId);
          await provider.refresh();
        }
        expect(row()).toMatchObject({ state: undefined, hasUnread: false });

        live.set(activeSessionId, {
          sessionId: activeSessionId,
          cwd: root,
          target: `pi-${activeSessionId}`,
        });
        await setPhase("waiting-user");
        expect(row().hasUnread).toBe(false);
      },
    );

    it("forgets unread and observed runs when archiving a session", async () => {
      const { webview, setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);

      await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
      expect(row()).toMatchObject({ isArchived: true, hasUnread: false });
      await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(false);
    });

    it("drops unread when a saved session disappears from the list", async () => {
      const { provider, filePath, setPhase, row, live } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      const savedSession = await readFile(filePath, "utf8");
      live.delete(activeSessionId);
      await rm(filePath);
      await provider.refresh();

      await writeFile(filePath, savedSession);
      await provider.refresh();
      expect(row().hasUnread).toBe(false);
    });

    it("ignores a stale refresh that finishes after a newer completion snapshot", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      let finishStale: ((ids: PiMuxWorkspace[]) => void) | undefined;
      mocks.list.mockImplementationOnce(
        () =>
          new Promise<PiMuxWorkspace[]>((resolve) => {
            finishStale = resolve;
          }),
      );
      const stale = provider.refresh();
      await vi.waitFor(() => {
        expect(finishStale).toBeDefined();
      });
      const latest = setPhase("waiting-user");
      finishStale!([
        {
          cwd: root,
          sessions: [
            { id: activeSessionId, file: "/saved/active.jsonl", state: "running", title: null },
          ],
          empty: [],
        },
      ]);
      await latest;
      await stale;

      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row().hasUnread).toBe(true);
    });
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

  it("restores saved history as archived despite old active membership after workspace reload", async () => {
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
    mockTerminal(runtimes.mocks, terminal, registry, root);

    await webview.receive({ type: "ready" });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toEqual([
      expect.objectContaining({ sessionId: activeSessionId, isArchived: true }),
    ]);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("opens a saved conversation temporarily without changing old membership or archive display", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes.mocks, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ shellArgs: ["open", "--temporary", activeSessionId] }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  /** Fixture for archived-display switching: both sessions listed, the
   * inactive one archived, and a reusable display terminal for the cwd. */
  async function archivedDisplayFixture(deps: Parameters<typeof createProvider>[0] = {}) {
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
    mockTerminal(runtimes.mocks, terminal, registry, root);
    const { provider, statePath } = createProvider({ registry, ...deps });
    runtimes.temporary.add(inactiveSessionId);

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    return { runtimes, registry, terminal, provider, statePath, webview };
  }

  it("unarchives the displayed temporary Pi through normal open without old membership writes", async () => {
    const { runtimes, webview, statePath, registry, terminal } = await archivedDisplayFixture();
    const before = await readFile(statePath, "utf8");
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.temporary.has(inactiveSessionId)).toBe(true);
    await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });
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
        ).isArchived,
    ).toBe(false);
  });

  it("reflects list promotion without sending state or updating old membership", async () => {
    const { runtimes, webview, provider, statePath } = await archivedDisplayFixture();
    const before = await readFile(statePath, "utf8");
    runtimes.temporary.delete(inactiveSessionId);
    runtimes.phases.set(inactiveSessionId, "running");
    await provider.refresh();
    const row = webview.postMessage.mock.calls
      .at(-1)?.[0]
      .state.groups[0].sessions.find(
        (row: { sessionId: string }) => row.sessionId === inactiveSessionId,
      );
    expect(row).toMatchObject({ isArchived: false, state: "running" });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(runtimes.mocks.open).not.toHaveBeenCalled();
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
  });

  it("preserves a promoted previous Pi when conditional close skips it after a switch", async () => {
    const { runtimes, webview, registry } = await archivedDisplayFixture();
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

  it("keeps the temporary collection and current Pi when list acquisition fails", async () => {
    const { runtimes, webview, provider, registry } = await archivedDisplayFixture();
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

  it.each(["missing", "invalid"] as const)(
    "performs Unarchive and Archive with %s old JSON",
    async (kind) => {
      const { runtimes, webview, statePath, registry } = await archivedDisplayFixture();
      if (kind === "missing") await rm(statePath);
      else await writeFile(statePath, "invalid JSON");
      await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });
      expect(registry.displayedSessionId).toBe(inactiveSessionId);
      expect(runtimes.temporary.has(inactiveSessionId)).toBe(false);
      await webview.receive({ type: "archiveSession", sessionId: inactiveSessionId });
      expect(runtimes.mocks.closeSession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
      expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
      expect(runtimes.live.has(inactiveSessionId)).toBe(false);
      expect(registry.displayedSessionId).toBe(activeSessionId);
      if (kind === "missing") expect(existsSync(statePath)).toBe(false);
      else expect(await readFile(statePath, "utf8")).toBe("invalid JSON");
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps normal Pi and unrelated temporary Pi when selecting another normal Pi", async () => {
    const { runtimes, webview, registry } = await archivedDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });
    const external = "external-temporary";
    runtimes.live.set(external, { sessionId: external, cwd: root, target: "external" });
    runtimes.temporary.add(external);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
    expect(runtimes.live.has(external)).toBe(true);
    expect(registry.displayedSessionId).toBe(activeSessionId);
  });

  it("does not change archive display or close the previous Pi when explicit Unarchive fails", async () => {
    const { runtimes, webview, registry } = await archivedDisplayFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    runtimes.mocks.list.mockRejectedValueOnce(new Error("lookup failed"));
    await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(runtimes.temporary.has(inactiveSessionId)).toBe(true);
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(
      webview.postMessage.mock.calls
        .filter(([message]) => message.type === "sessions")
        .at(-1)?.[0]
        .state.groups[0].sessions.find(
          (row: { sessionId: string }) => row.sessionId === inactiveSessionId,
        ).isArchived,
    ).toBe(true);
  });

  it("stops an archived previous display when the shared display moves away", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    // opening the archived session keeps its tmux session alive while displayed
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // switching to the unarchived session stops the archived one
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
    expect(runtimes.live.has(activeSessionId)).toBe(true);

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("stops an archived previous display when a new session replaces it", async () => {
    const newSessionId = "00000000-0000-4000-8000-000000000003";
    const { registry, runtimes, webview } = await archivedDisplayFixture({
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

  it("keeps the archived display when starting a new session fails", async () => {
    const { runtimes, webview } = await archivedDisplayFixture({
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

  it("keeps the archived display when a failed launch closed the shared display", async () => {
    const { registry, runtimes, terminal, webview } = await archivedDisplayFixture({
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

  it("keeps a session that came back from the archive alive when the display moves away", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });

    expect(runtimes.temporary.has(inactiveSessionId)).toBe(false);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("does not stop the archived display when it is selected again", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the archived display when switching to the other session fails", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // the switch target lost its session file: the open fails and the
    // display stays on the archived session, which must stay alive
    await rm(join(root, "sessions", `${activeSessionId}.jsonl`));
    runtimes.live.delete(activeSessionId);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("closes the previous temporary Pi even when old membership is invalid", async () => {
    const { statePath, runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await writeFile(statePath, "not json", "utf8");
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledExactlyOnceWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe("not json");
  });

  it("stops the archived display when the store file is missing", async () => {
    const { statePath, runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await rm(statePath);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.closeTemporarySession).toHaveBeenCalledWith(inactiveSessionId);
  });

  it("reports the failure but keeps the new display when stopping the archived display fails", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

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
    mockTerminal(runtimes.mocks, terminal, registry, root);
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

  it("unarchives a requested archived session, opens it, and refreshes the list", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes.mocks, terminal, registry, root);
    const { provider } = createProvider({ registry });

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isArchived: false,
    });
    // the session that just came back from the archive opens in the shared terminal
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: homedir() } }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it.each(["openSession", "unarchiveSession"] as const)(
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

  it("unarchives and reconnects a live session after its saved file disappeared", async () => {
    const { provider, webview, filePath, live, mocks, terminal, registry } = await archiveFixture();

    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isArchived: false,
    });
    const runtime = { sessionId: activeSessionId, cwd: root, target: `pi-${activeSessionId}` };
    live.set(activeSessionId, runtime);
    await rm(filePath);

    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

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
      const { provider, webview, filePath, mocks, registry } = await archiveFixture();

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

      await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

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

  it("unarchives a live Pi even when the old store directory is read-only", async () => {
    const { webview, statePath, registry, mocks } = await archiveFixture();
    const before = await readFile(statePath, "utf8");
    await chmod(root, 0o500);
    try {
      await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });
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

  it("opens an unregistered cwd directly in Pi without workbench side effects", async () => {
    const runtimes = providerRuntimes();
    await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes.mocks, terminal, registry, root);
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
    mockTerminal(mocks, terminal, registry, root);
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

  it.each(["absent", "unavailable", "error", "lookup-error"] as const)(
    "does not open or create a session when its saved file disappeared and liveness is %s",
    async (liveness) => {
      const { webview, statePath, filePath, mocks, registry } = await archiveFixture();
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

  describe("selection follows the new session display", () => {
    let fixture: Awaited<ReturnType<typeof archivedDisplayFixture>>;
    let launcher: SessionLauncher;
    let onSessionStarted: Mock<(sessionId: string) => Promise<void>>;

    beforeEach(async () => {
      fixture = await archivedDisplayFixture({ startNewSession: (cwd) => launcher.start(cwd) });
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
        fixture.registry.mux,
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
      expect(newRow?.isArchived).toBe(false);
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
  });

  it("opens a live session when its saved session file disappeared", async () => {
    const runtimes = providerRuntimes();
    const filePath = await seedSavedSession(activeSessionId, root, { runtimes });
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
    mockTerminal(runtimes.mocks, terminal, registry, root);
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

  it("starts a new session only when the fixed protocol requests it", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "newSession", cwd: root });
    await webview.receive({ type: "shell", command: "pi" });

    expect(startNewSession).toHaveBeenCalledTimes(1);
    expect(startNewSession).toHaveBeenCalledWith(root);
  });

  it("launches the requested group cwd for the new session", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    await seedSavedSession(inactiveSessionId);
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "newSession", cwd: root });

    expect(startNewSession).toHaveBeenCalledWith(root);
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
      },
    ];
    const fakePiMuxCommand = vi.fn(async (executable: string, args: string[], cwd?: string) => {
      expect(executable).toBe("pi-mux");
      if (args.join(" ") === "new --detached") {
        expect(cwd).toBe(root);
        mocks.open({ sessionId: activeSessionId, cwd: root });
        return `Pi session ${activeSessionId}\nAttach with: pi-mux open ${activeSessionId}\n`;
      }
      if (args.join(" ") === "list") {
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
      if (args[0] === "history") return JSON.stringify(historyEntries);
      if (args[0] === "current") {
        const runtime = client.attachedId === undefined ? undefined : live.get(client.attachedId);
        if (runtime === undefined) throw new Error("cannot resolve the client");
        return JSON.stringify({
          id: runtime.sessionId,
          cwd: runtime.cwd,
          file: join(cwdDir, `2024-12-03_${runtime.sessionId}.jsonl`),
          target: `pi-${runtime.sessionId}`,
        });
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

    expect(
      fakePiMuxCommand.mock.calls.some(([, args]) => args.join(" ") === "new --detached"),
    ).toBe(true);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shellPath: "pi-mux", shellArgs: ["open", activeSessionId] }),
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
    });
    await webview.receive({ type: "refresh" });

    const refreshed = sentState();
    expect(refreshed.displayedSessionId).toBe(activeSessionId);
    expect(refreshed.groups[0].sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: activeSessionId,
          displayName: "Saved fixture conversation",
          isArchived: false,
        }),
        expect.objectContaining({ sessionId: inactiveSessionId, isArchived: true }),
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

  describe("workspace unregister with background prewarming", () => {
    function poolProviderFixture() {
      const saved = new Set<string>();
      const { mocks, live, emptyIds, workspaces } = sharedRuntimes;
      mocks.newSession.mockImplementation(async (cwd) => {
        const directory = await realpath(cwd);
        const reusable = [...live.values()].find(
          (runtime) =>
            runtime.cwd === directory &&
            emptyIds.has(runtime.sessionId) &&
            !saved.has(`/sessions/${runtime.sessionId}.jsonl`),
        );
        if (reusable !== undefined) return reusable.sessionId;
        const sessionId = `new-${mocks.newSession.mock.calls.length}`;
        live.set(sessionId, { sessionId, cwd: directory, target: `pi-${sessionId}` });
        emptyIds.add(sessionId);
        workspaces.add(cwd);
        return sessionId;
      });
      const fileExists = vi.fn(async (file: string) => saved.has(file));
      const onError = vi.fn();
      const pool = new EmptySessionPool({ mux: sharedRuntimes.mux, fileExists, onError });
      emptyPools.push(pool);
      const registry = createRegistry();
      const terminal = { processId: Promise.resolve(123), show: vi.fn(), dispose: vi.fn() };
      mockTerminal(sharedRuntimes.mocks, terminal, registry, root);
      const launcher = new SessionLauncher({
        registry,
        emptySessions: pool,
        onSessionStarted: () => provider.refresh(),
      });
      const { provider } = createProvider({
        registry,
        emptySessions: pool,
        onWorkspaces: (cwds) => pool.syncWorkspaces(cwds),
        startNewSession: (cwd) => launcher.start(cwd),
      });
      const webview = createView();
      return { pool, provider, webview, saved, fileExists, onError, launcher };
    }

    it.each([false, true])(
      "drains an issued startup before unregister and rejects stale list sync (alias=%s)",
      async (alias) => {
        const aliasCwd = join(root, "alias");
        if (alias) {
          await symlink(root, aliasCwd);
          sharedRuntimes.workspaces.add(aliasCwd);
        }
        const events: string[] = [];
        const startup = deferred<void>();
        const { mocks, live, workspaces, emptyIds } = sharedRuntimes;
        mocks.newSession.mockImplementationOnce(async (cwd) => {
          events.push("new:start");
          await startup.promise;
          live.set("late", { sessionId: "late", cwd: root, target: "late-target" });
          emptyIds.add("late");
          workspaces.add(cwd);
          events.push("new:complete");
          return "late";
        });
        const unregister = mocks.unregisterWorkspace.getMockImplementation()!;
        mocks.unregisterWorkspace.mockImplementationOnce(async (cwd) => {
          events.push("unregister");
          await unregister(cwd);
        });
        const { pool, provider, webview, onError, launcher } = poolProviderFixture();
        if (alias) {
          pool.syncWorkspaces([aliasCwd]);
          await vi.waitFor(() =>
            expect(mocks.newSession).toHaveBeenCalledExactlyOnceWith(aliasCwd),
          );
        }
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });
        await vi.waitFor(() => expect(mocks.newSession).toHaveBeenCalledOnce());

        const staleList = deferred<void>();
        const queried = deferred<void>();
        const list = mocks.list.getMockImplementation()!;
        mocks.list.mockImplementationOnce(async () => {
          const snapshot = await list();
          queried.resolve();
          await staleList.promise;
          return snapshot;
        });
        const refreshing = provider.refresh();
        await queried.promise;
        const suspend = vi.spyOn(pool, "suspendWorkspace");
        const removing = webview.receive({ type: "unregisterWorkspace", cwd: root });
        await vi.waitFor(() => expect(suspend).toHaveBeenCalledExactlyOnceWith(root));
        pool.syncWorkspaces(alias ? [root, aliasCwd] : [root]);
        expect(mocks.unregisterWorkspace).not.toHaveBeenCalled();
        expect(events).toEqual(["new:start"]);

        startup.resolve();
        await vi.waitFor(() => expect(mocks.unregisterWorkspace).toHaveBeenCalledOnce());
        staleList.resolve();
        await Promise.all([refreshing, removing]);
        await provider.refresh();
        await provider.refresh();
        expect(events).toEqual(["new:start", "new:complete", "unregister"]);
        expect(mocks.newSession).toHaveBeenCalledOnce();
        expect(workspaces.has(root)).toBe(false);
        expect(live.has("late")).toBe(false);
        expect(onError).not.toHaveBeenCalled();

        const reRegisteredCwd = alias ? join(root, "new-alias") : root;
        if (alias) await symlink(root, reRegisteredCwd);
        workspaces.add(reRegisteredCwd);
        await provider.refresh();
        await vi.waitFor(() => expect(mocks.newSession).toHaveBeenCalledTimes(2));
        expect(workspaces.has(reRegisteredCwd)).toBe(true);
        launcher.dispose();
      },
    );

    it("does not propagate an unrelated cwd EACCES into workspace unregister", async () => {
      const blockedParent = join(root, "blocked");
      const blockedCwd = join(blockedParent, "workspace-b");
      await mkdir(blockedCwd, { recursive: true });
      const validationStarted = deferred<void>();
      const releaseValidation = deferred<void>();
      const requireDirectory = workDirectory.requireWorkDirectory;
      vi.spyOn(workDirectory, "requireWorkDirectory").mockImplementation(async (cwd) => {
        if (cwd === blockedCwd) {
          validationStarted.resolve();
          await releaseValidation.promise;
        }
        return requireDirectory(cwd);
      });
      sharedRuntimes.workspaces.add(blockedCwd);
      const { pool, provider, webview, fileExists, onError, launcher } = poolProviderFixture();
      await chmod(blockedParent, 0o000);
      try {
        await expect(realpath(blockedCwd)).rejects.toMatchObject({ code: "EACCES" });
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });
        await validationStarted.promise;
        await vi.waitFor(() => expect(fileExists).toHaveBeenCalledOnce());
        const suspend = vi.spyOn(pool, "suspendWorkspace");
        const removing = webview.receive({ type: "unregisterWorkspace", cwd: root });
        await vi.waitFor(() => expect(suspend).toHaveBeenCalledExactlyOnceWith(root));
        releaseValidation.resolve();
        await removing;
        await vi.waitFor(() =>
          expect(onError).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(`Empty Pi session in ${blockedCwd}: EACCES`),
          ),
        );
        expect(sharedRuntimes.mocks.unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(root);
        expect(sharedRuntimes.workspaces.has(root)).toBe(false);
        expect(sharedRuntimes.workspaces.has(blockedCwd)).toBe(true);
        expect(sharedRuntimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(root);
        expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        releaseValidation.resolve();
        await chmod(blockedParent, 0o700);
        launcher.dispose();
      }
    });

    it.each(["addWorkspace", "newSession", "openSession"] as const)(
      "does not refill after a failed unregister until an explicit %s request",
      async (request) => {
        await seedSavedSession(activeSessionId);
        const { mocks, live, workspaces, emptyIds } = sharedRuntimes;
        const { pool, provider, webview, saved, fileExists, onError, launcher } =
          poolProviderFixture();
        provider.resolveWebviewView(webview.view as never);
        await webview.receive({ type: "ready" });
        await vi.waitFor(() => expect(fileExists).toHaveBeenCalledOnce());

        const events: string[] = [];
        const refill = deferred<void>();
        mocks.newSession.mockImplementationOnce(async (cwd) => {
          events.push("refill:start");
          await refill.promise;
          live.set("late-refill", { sessionId: "late-refill", cwd, target: "refill-target" });
          emptyIds.add("late-refill");
          workspaces.add(cwd);
          events.push("refill:complete");
          return "late-refill";
        });
        mocks.unregisterWorkspace.mockImplementationOnce(async () => {
          events.push("unregister:failed");
          live.clear();
          throw new Error("restore removal denied after stopping Pi");
        });
        saved.add("/sessions/new-1.jsonl");
        pool.onSessionFileChanged("/sessions/new-1.jsonl");
        await vi.waitFor(() => expect(mocks.newSession).toHaveBeenCalledTimes(2));
        const removing = webview.receive({ type: "unregisterWorkspace", cwd: root });
        await vi.waitFor(() => expect(events).toEqual(["refill:start"]));
        pool.syncWorkspaces([root]);
        expect(mocks.unregisterWorkspace).not.toHaveBeenCalled();
        refill.resolve();
        await removing;
        await provider.refresh();
        pool.syncWorkspaces([]);
        pool.syncWorkspaces([root]);
        pool.onSessionFileChanged("/sessions/new-1.jsonl");
        await provider.refresh();
        expect(events).toEqual(["refill:start", "refill:complete", "unregister:failed"]);
        expect(mocks.newSession).toHaveBeenCalledTimes(2);
        expect(workspaces.has(root)).toBe(true);
        expect(live.size).toBe(0);
        expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining("restore removal denied after stopping Pi"),
        );

        await webview.receive(
          request === "addWorkspace"
            ? { type: request, path: root }
            : request === "newSession"
              ? { type: request, cwd: root }
              : { type: request, sessionId: activeSessionId },
        );
        await vi.waitFor(() =>
          expect(mocks.newSession).toHaveBeenCalledTimes(request === "newSession" ? 4 : 3),
        );
        const newestId = [...live.keys()].find((id) => id.startsWith("new-"))!;
        const file = `/sessions/${newestId}.jsonl`;
        await vi.waitFor(() =>
          expect(fileExists.mock.calls.filter(([candidate]) => candidate === file)).toHaveLength(
            request === "newSession" ? 2 : 1,
          ),
        );
        const beforeSave = mocks.newSession.mock.calls.length;
        saved.add(file);
        pool.onSessionFileChanged(file);
        await vi.waitFor(() => expect(mocks.newSession).toHaveBeenCalledTimes(beforeSave + 1));
        expect(onError).not.toHaveBeenCalled();
        launcher.dispose();
      },
    );
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
          sessions: [expect.objectContaining({ sessionId: activeSessionId, isArchived: true })],
        }),
      );
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

    it("delegates same-cwd stopping and unregister to CLI then refreshes without changing saved files", async () => {
      const { provider, webview, mocks, live, workspaces, filePath, statePath } =
        await archiveFixture();
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

    it("retains the registered group without restart or refresh after unregister fails", async () => {
      const { webview, mocks, live, workspaces } = await archiveFixture();
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

  async function selectionFixture() {
    const fixture = await archiveFixture();
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

  it.each([false, true])(
    "opens only the latest pending row without interrupting the running selection (archived=%s)",
    async (archived) => {
      const fixture = await selectionFixture();
      const { webview, mocks, registry, statePath, provider, shown, filePath } = fixture;

      if (archived) fixture.live.clear();
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
        archived ? [activeSessionId, unknownSessionId] : [activeSessionId],
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
    mocks.current.mockRejectedValueOnce(new Error("target lookup failed"));
    opening.finish();
    await Promise.all([first, invalid, latest]);
    expect(shown).toEqual([unknownSessionId]);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("target lookup failed"),
    );
  });

  it.each(["archiveSession", "unarchiveSession", "newSession"] as const)(
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
        type === "archiveSession"
          ? `stop:${inactiveSessionId}`
          : type === "unarchiveSession"
            ? `open:${inactiveSessionId}`
            : "newSession";
      expect(events).toEqual([
        `open:${activeSessionId}`,
        expectedOperation,
        `open:${unknownSessionId}`,
      ]);
    },
  );

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
    mockTerminal(mocks, terminal, registry, root);
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

  it.each(["list", "switch"] as const)(
    "keeps archived metadata unchanged when the pi-mux %s command fails",
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

  it.each([
    { type: "copySessionId", sessionId: activeSessionId },
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

  it("shows an error and sends no list when history cannot be read", async () => {
    sharedRuntimes.mocks.history.mockRejectedValue(new Error("EACCES: permission denied"));
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(
      /^Failed to read Pi sessions: /,
    );
    const lastCall = webview.postMessage.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual({
      type: "sessionsError",
      message: expect.stringMatching(/^Failed to read Pi sessions: /),
    });
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(false);
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

  it("archives without consulting invalid old membership", async () => {
    const { webview, statePath, mocks, live } = await archiveFixture();
    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe("{ invalid");
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("notifies when postMessage reports the webview was not updated", async () => {
    const { provider } = createProvider();
    const webview = createView();
    webview.postMessage.mockResolvedValueOnce(false);
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();
    await vi.waitFor(() => {
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        "Failed to update the Sessions view.",
      );
    });
  });

  it("notifies when postMessage rejects", async () => {
    const { provider } = createProvider();
    const webview = createView();
    webview.postMessage.mockRejectedValueOnce(new Error("webview gone"));
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();
    await vi.waitFor(() => {
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        "Failed to update the Sessions view.",
      );
    });
  });

  it("closes the confirmed conversation while retaining old membership and its source", async () => {
    const { webview, registry, terminal, live, mocks, filePath } = await archiveFixture();
    const source = await readFile(filePath, "utf8");
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.open({ sessionId: inactiveSessionId, cwd: root });
    const otherRuntime = live.get(inactiveSessionId);
    const stop = mocks.closeSession.getMockImplementation()!;
    mocks.closeSession.mockImplementationOnce(async (sessionId) => {
      return stop(sessionId);
    });

    await webview.receive({
      type: "archiveSession",
      sessionId: activeSessionId,
      target: "arbitrary",
      pid: 1,
    });

    expect(mocks.closeSession).toHaveBeenCalledWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.get(inactiveSessionId)).toBe(otherRuntime);

    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(inactiveSessionId);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      inactiveSessionId,
    );
    expect(await readFile(filePath, "utf8")).toBe(source);

    const startsBefore = mocks.open.mock.calls.length;
    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });
    // unarchive reopens the stored conversation: Pi starts again from the same source
    expect(mocks.open).toHaveBeenCalledTimes(startsBefore + 1);
    expect(mocks.open).toHaveBeenLastCalledWith({ sessionId: activeSessionId, cwd: root });
  });

  it("closes the displayed archive target when only archived or different-cwd alternatives remain", async () => {
    const { webview, registry, terminal, live, provider } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    live.get(inactiveSessionId)!.cwd = join(root, "another-workspace");
    await provider.refresh();
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("does not reopen a tab the user closed before archiving", async () => {
    const { webview, registry, terminal, live } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    registry.onTerminalClosed(terminal as never);
    const created = vscodeMocks.createTerminal.mock.calls.length;
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(created);
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.has(inactiveSessionId)).toBe(true);
  });

  it("completes archive and closes the tab when switching fails", async () => {
    const { webview, registry, terminal, live, mocks } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.switch.mockRejectedValueOnce(new Error("switch denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has(activeSessionId)).toBe(false);

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("switch denied"),
    );
  });

  it("completes archive when replacement discovery fails", async () => {
    const { webview, registry, terminal, live, mocks } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.list.mockRejectedValueOnce(new Error("list denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has(activeSessionId)).toBe(false);
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("list denied"),
    );
  });

  it("archives and closes a confirmed restored display when the next client lookup fails", async () => {
    const { webview, registry, terminal, mocks, client, live } = await archiveFixture();
    const restored = terminal;
    Object.assign(restored.creationOptions, {
      env: { PI_SESSIONS_DISPLAY: "1" },
    });
    Object.assign(vscodeMocks.terminals, [restored]);
    client.attachedId = activeSessionId;
    const current = {
      id: activeSessionId,
      cwd: root,
      file: `/saved/${activeSessionId}.jsonl`,
      target: `pi-${activeSessionId}`,
    };
    mocks.current
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockRejectedValue(new Error("client lookup denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);

    expect(restored.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("client lookup denied"),
    );
    vscodeMocks.terminals.length = 0;
  });

  it("closes its restored tab through the in-stop lookup after an initial display lookup failure", async () => {
    const { webview, registry, terminal, mocks, client, live } = await archiveFixture();
    const restored = terminal;
    Object.assign(restored.creationOptions, {
      env: { PI_SESSIONS_DISPLAY: "1" },
    });
    Object.assign(vscodeMocks.terminals, [restored]);
    client.attachedId = activeSessionId;
    mocks.current.mockRejectedValueOnce(new Error("initial client lookup denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(restored.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    vscodeMocks.terminals.length = 0;
  });

  it("keeps an unrelated restored tab when display lookup fails", async () => {
    const { webview, terminal, mocks, client, live } = await archiveFixture();
    const restored = terminal;
    Object.assign(restored.creationOptions, {
      env: { PI_SESSIONS_DISPLAY: "1" },
    });
    Object.assign(vscodeMocks.terminals, [restored]);
    client.attachedId = inactiveSessionId;
    mocks.current.mockRejectedValue(new Error("client lookup denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.has(inactiveSessionId)).toBe(true);

    expect(restored.dispose).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    vscodeMocks.terminals.length = 0;
  });

  it("archives a background conversation while preserving another display and selection", async () => {
    const { webview, terminal, registry, live, mocks } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.open({ sessionId: inactiveSessionId, cwd: root });
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const otherRuntime = live.get(inactiveSessionId);
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.get(inactiveSessionId)).toBe(otherRuntime);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(inactiveSessionId);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      inactiveSessionId,
    );
  });

  it("still calls close before archiving a stopped session absent from list", async () => {
    const { webview, mocks, live, registry } = await archiveFixture();
    live.delete(activeSessionId);
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);

    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("does not restart Pi or change membership and selection when close fails after Pi exits", async () => {
    const { webview, statePath, mocks, live, terminal, registry } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    const starts = mocks.open.mock.calls.length;
    mocks.closeSession.mockImplementationOnce(async (sessionId) => {
      live.delete(sessionId);
      throw new Error("restore candidate removal failed");
    });
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
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

  it("leaves membership and display unchanged when close fails", async () => {
    const { webview, statePath, mocks, terminal, registry } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    mocks.closeSession.mockRejectedValueOnce(new Error("stop denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/Failed to stop Pi session .*stop denied/),
    );
  });

  it("archives successfully without writing into a read-only old-store directory", async () => {
    const { webview, statePath, mocks, live, registry } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    await chmod(root, 0o500);
    try {
      await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(live.has(activeSessionId)).toBe(false);
      expect(registry.displayedSessionId).toBe(inactiveSessionId);
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
      expect(mocks.closeTemporarySession).not.toHaveBeenCalled();
      expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("rejects an unknown session but does not gate close on invalid old membership", async () => {
    const { webview, statePath, mocks } = await archiveFixture();
    const before = await readFile(statePath, "utf8");
    await webview.receive({ type: "archiveSession", sessionId: unknownSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(activeSessionId);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it("serializes archive and a later All open without forbidding archived runtimes", async () => {
    const { webview, mocks, live } = await archiveFixture();
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
    const archived = webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    const opened = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledTimes(1));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([archived, opened]);

    expect(live.has(activeSessionId)).toBe(true);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
