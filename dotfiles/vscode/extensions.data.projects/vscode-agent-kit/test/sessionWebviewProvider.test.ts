import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  activeSessionIds,
  addActiveSession,
  archiveSessions,
  mutateSessionStateStore,
  readSessionStateStore,
  registerWorkspace,
  registeredWorkspaceCwds,
  type SessionStateStoreData,
} from "../src/sessionStateStore";
import { SessionLauncher } from "../src/launcher";
import { PiMux } from "../src/piMux";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { encodeCwdDirName } from "../src/paths";
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

beforeEach(async () => {
  root = await tempDir("pi-webview-provider-test-");
  vi.resetAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup(root);
});

function createView() {
  let receiveMessage: ((message: unknown) => Promise<void>) | undefined;
  let visibilityListener: (() => void) | undefined;
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
    onDidDispose: () => ({ dispose: () => {} }),
  };
  return {
    view,
    postMessage,
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

function createRuntimeRegistry() {
  const runtimes = fakeRuntimes();
  return {
    ...runtimes,
    registry: new TerminalRegistry(runtimes.store, editorTerminals(runtimes.store), runtimes.mux),
  };
}

function createRegistry() {
  return createRuntimeRegistry().registry;
}

function mockTerminal(mocks: ReturnType<typeof fakeRuntimes>["mocks"], terminal: object): void {
  vscodeMocks.createTerminal.mockImplementation((options) => {
    const sessionId = options.shellArgs?.[1];
    if (typeof sessionId === "string") {
      mocks.open({ sessionId, cwd: options.cwd.fsPath });
    }
    return terminal;
  });
}

function createProvider(
  deps: Partial<ConstructorParameters<typeof SessionWebviewProvider>[0]> = {},
) {
  const statePath = deps.statePath ?? join(root, "session-state.json");
  const provider = new SessionWebviewProvider({
    extensionUri: root,
    sessionDir: join(root, "sessions"),
    registry: createRegistry(),
    startNewSession: async () => {},
    ...deps,
    statePath,
  } as ConstructorParameters<typeof SessionWebviewProvider>[0]);
  return { provider, statePath };
}

/** Set up the store: register the cwd and mark the given sessions active.
 * Sessions left out are inactive (archived) and only visible in All mode. */
function setUpStore(statePath: string, cwd: string, activeIds: readonly string[]): void {
  expect(registerWorkspace(statePath, cwd).ok).toBe(true);
  for (const sessionId of activeIds) {
    expect(addActiveSession(statePath, cwd, sessionId).ok).toBe(true);
  }
}

function readStore(statePath: string): SessionStateStoreData {
  const read = readSessionStateStore(statePath);
  if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
  return read.data;
}

async function archiveFixture() {
  const sessionDir = join(root, "sessions");
  const filePath = await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
    header({ id: activeSessionId, cwd: root }),
  ]);
  await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "other.jsonl", [
    header({ id: inactiveSessionId, cwd: root }),
  ]);
  const runtimes = fakeRuntimes();
  const registry = new TerminalRegistry(
    runtimes.store,
    editorTerminals(runtimes.store),
    runtimes.mux,
  );
  const terminal = {
    creationOptions: { cwd: root },
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(() => registry.onTerminalClosed(terminal as never)),
  };
  mockTerminal(runtimes.mocks, terminal);
  const { provider, statePath } = createProvider({ sessionDir, registry });
  setUpStore(statePath, root, [activeSessionId, inactiveSessionId]);
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
    expect(
      mutateSessionStateStore(fixture.statePath, (store) => {
        const entry = store["active-workspaces"][root]?.["active-sessions"]?.[sessionId];
        if (entry === undefined) throw new Error("session entry missing");
        if (phase === undefined) delete entry.state;
        else entry.state = phase;
        return true;
      }).ok,
    ).toBe(true);
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
    let release: ((ids: Set<string>) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const response = new Promise<Set<string>>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    fixture.mocks.aliveSessionIds.mockImplementationOnce(() => {
      signalStarted!();
      return response;
    });
    function finish() {
      release!(new Set(fixture.live.keys()));
    }
    return { started, finish };
  }

  await setPhase("waiting-user");
  return { ...fixture, setPhase, sentState, row, holdRuntimeQuery };
}

async function loadingFixture() {
  const sessionDir = join(root, "sessions");
  await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
    header({ id: activeSessionId, cwd: root }),
  ]);
  const { store, mux, mocks } = fakeRuntimes();
  const registry = new TerminalRegistry(store, editorTerminals(store), mux);
  const { provider, statePath } = createProvider({ sessionDir, registry });
  expect(
    mutateSessionStateStore(statePath, (data) => {
      data["active-workspaces"][root] = {
        "active-sessions": { [activeSessionId]: { state: "running" } },
      };
      return true;
    }).ok,
  ).toBe(true);
  const webview = createView();
  provider.resolveWebviewView(webview.view as never);
  await vi.waitFor(() =>
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
    }),
  );
  webview.postMessage.mockClear();
  mocks.aliveSessionIds.mockClear();
  return { provider, statePath, webview, mocks };
}

describe("SessionWebviewProvider", () => {
  it("reuses the in-flight initial scan when the client becomes ready", async () => {
    const listSessions = vi.spyOn(sessionStore, "listSessions");
    const { provider } = await loadingFixture();
    listSessions.mockClear();
    const webview = createView();

    provider.resolveWebviewView(webview.view as never);
    await webview.receive({ type: "ready" });

    expect(listSessions).toHaveBeenCalledOnce();
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.objectContaining({
        groups: [expect.objectContaining({ cwd: root })],
      }),
    });
  });

  it("delivers the in-flight initial scan error to a ready client without scanning again", async () => {
    const listSessions = vi.spyOn(sessionStore, "listSessions");
    const { provider } = await loadingFixture();
    listSessions.mockClear();
    let rejectScan!: (error: Error) => void;
    const scan = new Promise<Awaited<ReturnType<typeof sessionStore.listSessions>>>((_, reject) => {
      rejectScan = reject;
    });
    listSessions.mockReturnValueOnce(scan);
    const webview = createView();

    provider.resolveWebviewView(webview.view as never);
    const ready = webview.receive({ type: "ready" });
    try {
      expect(listSessions).toHaveBeenCalledOnce();
      expect(webview.postMessage.mock.calls.every(([message]) => message.type === "loading")).toBe(
        true,
      );
    } finally {
      rejectScan(new Error("Session scan failed"));
      await ready;
    }

    expect(listSessions).toHaveBeenCalledOnce();
    expect(
      webview.postMessage.mock.calls.filter(([message]) => message.type !== "loading"),
    ).toEqual([
      [{ type: "sessionsError", message: "Failed to read Pi sessions: Session scan failed" }],
    ]);
  });

  it("replays the completed initial result to a ready client without scanning again", async () => {
    const listSessions = vi.spyOn(sessionStore, "listSessions");
    const { webview } = await loadingFixture();

    await webview.receive({ type: "ready" });

    expect(listSessions).toHaveBeenCalledOnce();
    expect(webview.postMessage).toHaveBeenCalledOnce();
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.objectContaining({ groups: [expect.objectContaining({ cwd: root })] }),
    });
  });

  it("replays the newest acquisition error rather than a stale list on ready", async () => {
    const { provider, statePath, webview } = await loadingFixture();
    await writeFile(statePath, "invalid json");
    await provider.refresh();
    const latestError = webview.postMessage.mock.lastCall?.[0];
    webview.postMessage.mockClear();
    vscodeMocks.showErrorMessage.mockClear();

    await webview.receive({ type: "ready" });

    expect(webview.postMessage.mock.calls).toEqual([[latestError]]);
    expect(latestError.type).toBe("sessionsError");
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("still rereads on an explicit refresh after initial ready", async () => {
    const listSessions = vi.spyOn(sessionStore, "listSessions");
    const { webview } = await loadingFixture();
    await webview.receive({ type: "ready" });
    listSessions.mockClear();

    await webview.receive({ type: "refresh" });

    expect(listSessions).toHaveBeenCalledOnce();
    expect(webview.postMessage.mock.calls.slice(-2).map(([message]) => message.type)).toEqual([
      "loading",
      "sessions",
    ]);
  });

  it("waits for the newest explicit refresh on ready without starting a third scan", async () => {
    const listSessions = vi.spyOn(sessionStore, "listSessions");
    const { provider, webview, mocks } = await loadingFixture();
    listSessions.mockClear();
    const completions: ((ids: Set<string>) => void)[] = [];
    mocks.aliveSessionIds.mockImplementation(
      () => new Promise<Set<string>>((resolve) => completions.push(resolve)),
    );
    const firstRefresh = provider.refresh();
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const latestRefresh = provider.refresh();
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    let readyFinished = false;
    const ready = webview.receive({ type: "ready" }).then(() => {
      readyFinished = true;
    });
    try {
      completions[0](new Set());
      await firstRefresh;
      expect(readyFinished).toBe(false);
      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(webview.postMessage.mock.calls.every(([message]) => message.type === "loading")).toBe(
        true,
      );
    } finally {
      for (const finish of completions) finish(new Set([activeSessionId]));
      await Promise.all([latestRefresh, ready]);
    }
    expect(readyFinished).toBe(true);
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
    });
  });

  it("announces loading before asynchronous refresh work finishes", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    let finish!: (ids: Set<string>) => void;
    const pending = new Promise<Set<string>>((resolve) => {
      finish = resolve;
    });
    mocks.aliveSessionIds.mockReturnValueOnce(pending);

    const refreshing = provider.refresh();
    try {
      await vi.waitFor(() => expect(mocks.aliveSessionIds).toHaveBeenCalledOnce());
      expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual(["loading"]);
    } finally {
      finish(new Set([activeSessionId]));
      await refreshing;
    }
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "sessions",
    ]);
  });

  it("reports operation errors separately while a list refresh is pending", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    let finish!: (ids: Set<string>) => void;
    mocks.aliveSessionIds.mockReturnValueOnce(
      new Promise<Set<string>>((resolve) => {
        finish = resolve;
      }),
    );
    const refreshing = provider.refresh();
    try {
      await vi.waitFor(() => expect(mocks.aliveSessionIds).toHaveBeenCalledOnce());
      await webview.receive({ type: "addWorkspace", path: "relative" });
      expect(webview.postMessage).toHaveBeenLastCalledWith({
        type: "error",
        message: expect.stringMatching(/^Invalid workspace path: /),
      });
      expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "loading",
        "error",
      ]);
    } finally {
      finish(new Set([activeSessionId]));
      await refreshing;
    }
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "error",
      "sessions",
    ]);
  });

  it("keeps loading until the newest overlapping refresh finishes", async () => {
    const { provider, webview, mocks } = await loadingFixture();
    const completions: ((ids: Set<string>) => void)[] = [];
    mocks.aliveSessionIds.mockImplementation(
      () =>
        new Promise<Set<string>>((resolve) => {
          completions.push(resolve);
        }),
    );
    const firstRefresh = provider.refresh();
    let secondRefresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      secondRefresh = provider.refresh();
      await vi.waitFor(() => expect(completions).toHaveLength(2));
      completions[0](new Set());
      await firstRefresh;
      expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
        "loading",
        "loading",
      ]);
    } finally {
      for (const finish of completions) finish(new Set([activeSessionId]));
      await Promise.all([firstRefresh, secondRefresh]);
    }
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "loading",
      "sessions",
    ]);
  });

  it("keeps the latest refresh error when an older refresh succeeds later", async () => {
    const { provider, statePath, webview, mocks } = await loadingFixture();
    let finish!: (ids: Set<string>) => void;
    mocks.aliveSessionIds.mockReturnValueOnce(
      new Promise<Set<string>>((resolve) => {
        finish = resolve;
      }),
    );
    const refreshing = provider.refresh();
    try {
      await vi.waitFor(() => expect(mocks.aliveSessionIds).toHaveBeenCalledOnce());
      await writeFile(statePath, "invalid json");
      await provider.refresh();
    } finally {
      finish(new Set([activeSessionId]));
      await refreshing;
    }
    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "loading",
      "sessionsError",
    ]);
  });

  it("ends loading with an error when the session state store cannot be read", async () => {
    const { provider, statePath } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await writeFile(statePath, "invalid json");
    webview.postMessage.mockClear();

    await webview.receive({ type: "refresh" });

    expect(webview.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "loading",
      "sessionsError",
    ]);
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "second.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);

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

    const store = readStore(statePath);
    // archiving deletes the session entry from the active-sessions map
    expect(activeSessionIds(store).has(activeSessionId)).toBe(false);
    expect(
      sentSessions().find((session) => session.sessionId === activeSessionId)?.isArchived,
    ).toBe(true);
  });

  it("archives legacy locked sessions and removes unrelated legacy locks", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
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
    const row = webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0];
    expect(row.isArchived).toBe(false);
    expect(row).not.toHaveProperty("isLocked");

    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });

    expect(readStore(statePath)).toEqual({
      "active-workspaces": {
        [root]: {
          "active-sessions": {
            [inactiveSessionId]: { state: "running", note: "keep" },
          },
        },
      },
      tags: ["keep"],
    });
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );
  });

  it("keeps legacy attributes unchanged when only refreshing the list", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "archiveSession", sessionId: unknownSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
    );
    // the failed request wrote nothing: the settings and the store keep their previous content
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
  });

  it("sends the stored phase of a session listed by pi-mux", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store, mux, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    expect(
      mutateSessionStateStore(statePath, (store) => {
        const entry = store["active-workspaces"][root]?.["active-sessions"]?.[activeSessionId];
        if (entry === undefined) throw new Error("session entry missing");
        entry.state = "running";
        return true;
      }).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].state).toBe(
      "running",
    );
  });

  it("drops the phase of a session absent from the pi-mux list (stale sweep)", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store, mux } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    expect(
      mutateSessionStateStore(statePath, (store) => {
        const entry = store["active-workspaces"][root]?.["active-sessions"]?.[activeSessionId];
        if (entry === undefined) throw new Error("session entry missing");
        entry.state = "running";
        return true;
      }).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    // the stale `running` entry stays on disk but the list shows no phase
    expect(
      webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].state,
    ).toBeUndefined();
    expect(
      readStore(statePath)["active-workspaces"][root]?.["active-sessions"]?.[activeSessionId],
    ).toEqual({
      state: "running",
    });
  });

  it("sends no phase when the pi-mux query fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store, mux, mocks, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    mocks.aliveSessionIds.mockResolvedValue(null);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    expect(
      mutateSessionStateStore(statePath, (store) => {
        const entry = store["active-workspaces"][root]?.["active-sessions"]?.[activeSessionId];
        if (entry === undefined) throw new Error("session entry missing");
        entry.state = "waiting-user";
        return true;
      }).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(
      webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].state,
    ).toBeUndefined();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
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
      const { provider, statePath, store, mux, setPhase, row, sentState } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      provider.dispose();

      const { provider: replacement } = createProvider({
        statePath,
        registry: new TerminalRegistry(store, editorTerminals(store), mux),
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

      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      held.finish();
      await completion;
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row().hasUnread).toBe(true);
    });

    it("does not let a delayed displayed completion clear a newer background completion", async () => {
      const { webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("running");
      const held = holdRuntimeQuery();
      const oldCompletion = setPhase("waiting-user");
      await held.started;

      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      held.finish();
      await oldCompletion;
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("does not let a delayed background completion undo a successful open acknowledgement", async () => {
      const { webview, setPhase, row, holdRuntimeQuery } = await unreadFixture();
      await setPhase("running");
      const held = holdRuntimeQuery();
      const completion = setPhase("waiting-user");
      await held.started;

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
      held.finish();
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
      mocks.aliveSessionIds.mockResolvedValueOnce(null);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      expect(row().hasUnread).toBe(false);
      held.finish();
      await completion;
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: false });
    });

    it("keeps tracking a running session selected during a transient pi-mux query failure", async () => {
      const { mocks, webview, setPhase, row } = await unreadFixture();
      await setPhase("running");
      mocks.aliveSessionIds.mockResolvedValueOnce(null);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("waiting-user");
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("preserves unread through a transient pi-mux query failure until recovery", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);

      mocks.aliveSessionIds.mockResolvedValueOnce(null);
      await provider.refresh();
      expect(row()).toMatchObject({ state: undefined, hasUnread: true });
      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("preserves an observed run when its completion cannot yet be checked against pi-mux", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      mocks.aliveSessionIds.mockResolvedValueOnce(null);
      await setPhase("waiting-user");
      expect(row().state).toBeUndefined();

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
      const { provider, filePath, setPhase, row } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      const savedSession = await readFile(filePath, "utf8");
      await rm(filePath);
      await provider.refresh();

      await writeFile(filePath, savedSession);
      await provider.refresh();
      expect(row().hasUnread).toBe(false);
    });

    it("ignores a stale refresh that finishes after a newer completion snapshot", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      let finishStale: ((ids: Set<string>) => void) | undefined;
      mocks.aliveSessionIds.mockImplementationOnce(
        () =>
          new Promise<Set<string>>((resolve) => {
            finishStale = resolve;
          }),
      );
      const stale = provider.refresh();
      await vi.waitFor(() => {
        expect(finishStale).toBeDefined();
      });
      await setPhase("waiting-user");
      finishStale!(new Set([activeSessionId]));
      await stale;

      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
      await provider.refresh();
      expect(row().hasUnread).toBe(true);
    });
  });

  it("reflects disk changes on refresh without automatic updates", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await vi.waitFor(() => {
      expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(true);
    });
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(1);

    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "second.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    // No file watcher: the displayed list stays as-is until Refresh arrives.
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);

    await webview.receive({ type: "refresh" });
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(2);
  });

  it("resends sessions after the recreated client announces it is ready", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
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

  it("restores active sessions from disk in a new provider after workspace reload", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const original = createProvider({ sessionDir });
    setUpStore(original.statePath, root, [activeSessionId]);
    original.provider.dispose();
    const { store, mux, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    const restored = createProvider({ sessionDir, registry });
    const webview = createView();
    restored.provider.resolveWebviewView(webview.view as never);
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    mockTerminal(mocks, terminal);

    await webview.receive({ type: "ready" });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toEqual([
      expect.objectContaining({ sessionId: activeSessionId, isArchived: false }),
    ]);
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("keeps an archived session archived when it is opened", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const { store: runtimeStore, mux, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(runtimeStore, editorTerminals(runtimeStore), mux);
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    expect(archiveSessions(statePath, [{ sessionId: activeSessionId, cwd: root }]).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    const store = readStore(statePath);
    // opening does not unarchive: the session stays out of the active map
    expect(activeSessionIds(store).has(activeSessionId)).toBe(false);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  /** Fixture for archived-display switching: both sessions listed, the
   * inactive one archived, and a reusable display terminal for the cwd. */
  async function archivedDisplayFixture(deps: Parameters<typeof createProvider>[0] = {}) {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "second.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const runtimes = fakeRuntimes();
    const registry = new TerminalRegistry(
      runtimes.store,
      editorTerminals(runtimes.store),
      runtimes.mux,
    );
    for (const sessionId of [activeSessionId, inactiveSessionId]) {
      runtimes.live.set(sessionId, { sessionId, cwd: root, target: `pi-${sessionId}` });
    }
    const terminal = {
      creationOptions: { cwd: root },
      processId: Promise.resolve(123),
      show: vi.fn(),
      dispose: vi.fn(() => registry.onTerminalClosed(terminal as never)),
    };
    mockTerminal(runtimes.mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry, ...deps });
    setUpStore(statePath, root, [activeSessionId]); // inactiveSessionId is archived
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    return { sessionDir, runtimes, registry, terminal, provider, statePath, webview };
  }

  it("stops an archived previous display when the shared display moves away", async () => {
    const { runtimes, statePath, webview } = await archivedDisplayFixture();

    // opening the archived session keeps its tmux session alive while displayed
    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // switching to the unarchived session stops the archived one
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.stop).toHaveBeenCalledWith(inactiveSessionId);
    expect(runtimes.live.has(inactiveSessionId)).toBe(false);
    expect(runtimes.live.has(activeSessionId)).toBe(true);

    // the stop only closes the tmux session: the store keeps the archived membership
    expect(activeSessionIds(readStore(statePath)).has(inactiveSessionId)).toBe(false);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("stops an archived previous display when a new session replaces it", async () => {
    const newSessionId = "00000000-0000-4000-8000-000000000003";
    const { registry, runtimes, webview } = await archivedDisplayFixture({
      startNewSession: async () => {
        runtimes.mocks.open({ sessionId: newSessionId, cwd: root });
        await registry.run(() => registry.open({ sessionId: newSessionId, cwd: root }));
      },
    });

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "newSession", cwd: root });
    expect(runtimes.mocks.stop).toHaveBeenCalledWith(inactiveSessionId);
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
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
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
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps a session that came back from the archive alive when the display moves away", async () => {
    const { runtimes, statePath, webview } = await archivedDisplayFixture();

    // Unarchive displays the archived session and makes it active again
    await webview.receive({ type: "unarchiveSession", sessionId: inactiveSessionId });
    expect(activeSessionIds(readStore(statePath)).has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("does not stop the archived display when it is selected again", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the archived display when switching to the other session fails", async () => {
    const { sessionDir, runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // the switch target lost its session file: the open fails and the
    // display stays on the archived session, which must stay alive
    await rm(join(sessionDir, encodeCwdDirName(root), "first.jsonl"));
    runtimes.live.delete(activeSessionId);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("keeps the archived display when the store read cannot confirm the archive", async () => {
    const { statePath, runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    await writeFile(statePath, "not json", "utf8");
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.stop).not.toHaveBeenCalled();
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);
  });

  it("stops the archived display when the store file is missing", async () => {
    const { statePath, runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(runtimes.live.has(inactiveSessionId)).toBe(true);

    // a missing store reads as an empty store: every session is archived,
    // matching the whitelist semantics of the list
    await rm(statePath);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(runtimes.mocks.stop).toHaveBeenCalledWith(inactiveSessionId);
  });

  it("reports the failure but keeps the new display when stopping the archived display fails", async () => {
    const { runtimes, webview } = await archivedDisplayFixture();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    runtimes.mocks.stop.mockRejectedValueOnce(new Error("tmux kill failed"));

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Failed to stop archived Pi session ${inactiveSessionId}: tmux kill failed`,
    );
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it("follows the shared terminal's displayed session in the sent state", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const { store: runtimeStore, mux, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(runtimeStore, editorTerminals(runtimeStore), mux);
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const { store: runtimeStore, mux, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(runtimeStore, editorTerminals(runtimeStore), mux);
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    expect(archiveSessions(statePath, [{ sessionId: activeSessionId, cwd: root }]).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

    const store = readStore(statePath);
    expect(activeSessionIds(store).has(activeSessionId)).toBe(true);
    expect(
      readStore(statePath)["active-workspaces"][root]?.["active-sessions"]?.[activeSessionId],
    ).toEqual({});
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isArchived: false,
    });
    // the session that just came back from the archive opens in the shared terminal
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: root } }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBe(
      activeSessionId,
    );
  });

  it.each(["openSession", "unarchiveSession"] as const)(
    "rejects an unknown live session id on %s without writing or creating a session",
    async (type) => {
      const sessionDir = join(root, "sessions");
      await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
        header({ id: activeSessionId, cwd: root }),
      ]);
      const { registry, live, mocks } = createRuntimeRegistry();
      live.set(unknownSessionId, {
        sessionId: unknownSessionId,
        cwd: root,
        target: `pi-${unknownSessionId}`,
      });
      const { provider, statePath } = createProvider({ sessionDir, registry });
      setUpStore(statePath, root, [activeSessionId]);
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      const before = await readFile(statePath, "utf8");

      await webview.receive({ type, sessionId: unknownSessionId });

      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        `Session not found: ${unknownSessionId}`,
      );
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
      expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(mocks.aliveSessionIds).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
    },
  );

  it("unarchives and reconnects a live session after its saved file disappeared", async () => {
    const { provider, statePath, webview, filePath, live, mocks, terminal, registry } =
      await archiveFixture();
    expect(archiveSessions(statePath, [{ sessionId: activeSessionId, cwd: root }]).ok).toBe(true);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isArchived: true,
    });
    const runtime = { sessionId: activeSessionId, cwd: root, target: `pi-${activeSessionId}` };
    live.set(activeSessionId, runtime);
    await rm(filePath);

    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

    expect(activeSessionIds(readStore(statePath)).has(activeSessionId)).toBe(true);
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
    "keeps unarchived membership without opening when its saved file disappeared and liveness is %s",
    async (liveness) => {
      const { provider, statePath, webview, filePath, mocks, registry } = await archiveFixture();
      expect(archiveSessions(statePath, [{ sessionId: activeSessionId, cwd: root }]).ok).toBe(true);
      await provider.refresh();
      await rm(filePath);
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

      expect(activeSessionIds(readStore(statePath)).has(activeSessionId)).toBe(true);
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

  it("does not connect a live session when saving its unarchived membership fails", async () => {
    const { provider, statePath, webview, filePath, live, mocks, registry } =
      await archiveFixture();
    expect(archiveSessions(statePath, [{ sessionId: activeSessionId, cwd: root }]).ok).toBe(true);
    await provider.refresh();
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });
    await rm(filePath);
    const before = await readFile(statePath, "utf8");
    const previousState = webview.postMessage.mock.calls.at(-1)?.[0];
    webview.postMessage.mockClear();
    await chmod(root, 0o500);
    try {
      await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });

      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(previousState.state.groups[0].sessions[0].isArchived).toBe(true);
      expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(
        false,
      );
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
      expect(mocks.aliveSessionIds).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBeUndefined();
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("opens an unregistered cwd directly in Pi without workbench side effects", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const { store, mux, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: { fsPath: root } }),
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.getWorkspaceFolder).not.toHaveBeenCalled();
    expect(vscodeMocks.updateWorkspaceFolders).not.toHaveBeenCalled();
    expect(vscodeMocks.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
    expect(vscodeMocks.getExtension).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("opens an existing session in an editor terminal and reuses it", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = {
      creationOptions: { cwd: { fsPath: root } },
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const { registry, mocks } = createRuntimeRegistry();
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: root },
        location: 1,
        shellPath: "pi-mux",
        shellArgs: ["open", activeSessionId],
      }),
    );
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith({ sessionId: activeSessionId, cwd: root });
    expect(terminal.show).toHaveBeenCalledTimes(2);
    // opening does not archive or unarchive: the settings and the store are unchanged
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
  });

  it.each(["absent", "unavailable", "error", "lookup-error"] as const)(
    "does not open or create a session when its saved file disappeared and liveness is %s",
    async (liveness) => {
      const { webview, statePath, filePath, mocks, registry } = await archiveFixture();
      const before = await readFile(statePath, "utf8");
      await rm(filePath);
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
        statePath: fixture.statePath,
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
      expect(fixture.terminal.show).toHaveBeenCalledTimes(2);
      expect(onSessionStarted).toHaveBeenCalledWith(displayedId);
      expect(activeSessionIds(readStore(fixture.statePath)).has(displayedId!)).toBe(true);
      const listedIds = sentState().groups.flatMap((group) =>
        group.sessions.map((session) => session.sessionId),
      );
      expect(listedIds).toContain(activeSessionId);
      expect(listedIds).not.toContain(displayedId);
      expect(selectedRows()).toHaveLength(0);
      expect(sentState().displayedSessionId).toBe(displayedId);
    });

    it("clears the old selection while the new session list scan is pending", async () => {
      const sessions = await sessionStore.listSessions(fixture.sessionDir, { cwds: [root] });
      let finish!: (result: typeof sessions) => void;
      const scan = vi.spyOn(sessionStore, "listSessions").mockReturnValueOnce(
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
          vi.spyOn(sessionStore, "listSessions").mockRejectedValue(new Error("scan failed"));
        }

        await fixture.webview.receive({ type: "newSession", cwd: root });
        const displayedId = fixture.registry.displayedSessionId;
        expect(displayedId).not.toBe(activeSessionId);
        expect(selectedRows()).toHaveLength(0);
        expect(sentState().displayedSessionId).toBe(displayedId);
        expect(sentState().groups[0].sessions).not.toHaveLength(0);
        expect(fixture.webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");

        await fixture.provider.refresh();
        expect(selectedRows()).toHaveLength(0);
        expect(sentState().displayedSessionId).toBe(displayedId);
        expect(fixture.webview.postMessage.mock.lastCall?.[0].type).toBe("sessionsError");
      },
    );

    it("keeps the current display selected when an earlier new session is saved and refreshed", async () => {
      await fixture.webview.receive({ type: "newSession", cwd: root });
      const pendingId = fixture.registry.displayedSessionId!;
      expect(activeSessionIds(readStore(fixture.statePath)).has(pendingId)).toBe(true);
      await fixture.webview.receive({ type: "openSession", sessionId: activeSessionId });
      await writeJsonl(join(fixture.sessionDir, encodeCwdDirName(root)), `new_${pendingId}.jsonl`, [
        header({ id: pendingId, cwd: root }),
      ]);

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
      await writeJsonl(
        join(fixture.sessionDir, encodeCwdDirName(root)),
        `new_${displayedId}.jsonl`,
        [header({ id: displayedId, cwd: root })],
      );

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
    const sessionDir = join(root, "sessions");
    const filePath = await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    const { store, mux, mocks, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
    mockTerminal(mocks, terminal);
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await rm(filePath);
    live.set(activeSessionId, {
      sessionId: activeSessionId,
      cwd: root,
      target: `pi-${activeSessionId}`,
    });

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "pi-mux",
        shellArgs: ["open", activeSessionId],
      }),
    );
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(mocks.newSession).not.toHaveBeenCalled();
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "old.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const { provider } = createProvider({ sessionDir, startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "newSession", cwd: root });

    expect(startNewSession).toHaveBeenCalledWith(root);
  });

  it("shows the immediately active new session as selected after its saved fixture arrives and is refreshed", async () => {
    const sessionDir = join(root, "sessions");
    const cwdDir = join(sessionDir, encodeCwdDirName(root));
    await writeJsonl(cwdDir, "old.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const statePath = join(root, "session-state.json");
    setUpStore(statePath, root, []);

    const { store, mocks, live } = fakeRuntimes();
    const fakePiMuxCommand = vi.fn(async (executable: string, args: string[], cwd?: string) => {
      expect(executable).toBe("pi-mux");
      if (args.join(" ") === "new --detached") {
        expect(cwd).toBe(root);
        mocks.open({ sessionId: activeSessionId, cwd: root });
        return `Pi session ${activeSessionId}\nAttach with: pi-mux open ${activeSessionId}\n`;
      }
      if (args.join(" ") === "list") {
        return JSON.stringify(
          [...live.values()].map((runtime) => ({
            id: runtime.sessionId,
            cwd: runtime.cwd,
            file: null,
            phase: null,
          })),
        );
      }
      throw new Error(`Unexpected pi-mux command: ${args.join(" ")}`);
    });
    const registry = new TerminalRegistry(
      store,
      editorTerminals(store),
      new PiMux(fakePiMuxCommand),
    );
    const terminal = { processId: Promise.resolve(123), show: vi.fn(), dispose: vi.fn() };
    vscodeMocks.createTerminal.mockImplementation(() => {
      expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
      return terminal;
    });
    const launcher = new SessionLauncher({
      statePath,
      registry,
      onSessionStarted: () => provider.refresh(),
    });
    const { provider } = createProvider({
      sessionDir,
      statePath,
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

    expect(fakePiMuxCommand).toHaveBeenCalledWith("pi-mux", ["new", "--detached"], root);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shellPath: "pi-mux", shellArgs: ["open", activeSessionId] }),
    );
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(sentState().displayedSessionId).toBe(activeSessionId);
    expect(sentState().groups[0].sessions.map((session) => session.sessionId)).toEqual([
      inactiveSessionId,
    ]);
    expect(renderedRows(sentState())).toEqual([]);
    expect(await sessionStore.listSessions(sessionDir, { cwds: [root] })).toHaveLength(1);
    const activeStoreBeforeSave = await readFile(statePath, "utf8");

    const savedFixture = await writeJsonl(cwdDir, `2024-12-03_${activeSessionId}.jsonl`, [
      header({ id: activeSessionId, cwd: root }),
      messageEntry("user", [{ type: "text", text: "Saved fixture conversation" }]),
    ]);
    const savedContents = await readFile(savedFixture, "utf8");
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
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
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

  it("registers a valid workspace folder and shows its empty group", async () => {
    const folder = join(root, "registered");
    await mkdir(folder, { recursive: true });
    const { provider, statePath } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "addWorkspace", path: folder });

    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: { cwd: string }[] } };
    expect(lastSessions.state?.groups?.map((group) => group.cwd)).toEqual([folder]);
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([folder]);
  });

  it("registers the expanded absolute path from a tilde input", async () => {
    const path = "~/registered/./";
    vi.stubEnv("HOME", root);
    const folder = join(root, "registered");
    await mkdir(folder);
    const { provider, statePath } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "addWorkspace", path });

    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([folder]);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups).toEqual([
      expect.objectContaining({ cwd: folder }),
    ]);
  });

  it("keeps an existing registration unchanged when adding a tilde input", async () => {
    const path = "~/registered/./";
    vi.stubEnv("HOME", root);
    const folder = join(root, "registered");
    await mkdir(folder);
    const { provider, statePath } = createProvider();
    expect(registerWorkspace(statePath, folder).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "addWorkspace", path });

    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([folder]);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups).toEqual([
      expect.objectContaining({ cwd: folder }),
    ]);
  });

  it("starts a tilde-registered workspace with a literal dollar-sign name", async () => {
    const folder = join(root, "space $PI_SESSIONS_TEST_CHILD");
    await mkdir(folder);
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_SESSIONS_TEST_CHILD", "other");
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const { provider, statePath } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({
      type: "addWorkspace",
      path: "~/space $PI_SESSIONS_TEST_CHILD",
    });
    const [storedCwd] = registeredWorkspaceCwds(readStore(statePath));
    expect(storedCwd).toBe(folder);

    await webview.receive({ type: "newSession", cwd: storedCwd });

    expect(startNewSession).toHaveBeenCalledWith(folder);
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("shows an error and keeps the store when the workspace path is invalid", async () => {
    const missing = join(root, "missing");
    const { provider, statePath } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "addWorkspace", path: missing });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(missing));
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(1); // only the initial ready refresh
  });

  it("registers a workspace whose cwd already has sessions", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "old.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups).toEqual([]); // the cwd is not registered yet, so its group is hidden

    await webview.receive({ type: "addWorkspace", path: `${root}/` });

    // registering creates the workspace entry; the sessions were never
    // members, so they show up archived
    expect(readStore(statePath)["active-workspaces"][root]).toEqual({ "active-sessions": {} });
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: { cwd: string }[] } };
    expect(lastSessions.state?.groups).toEqual([expect.objectContaining({ cwd: root })]);
    // archived sessions exist in the payload; the webview's default Unarchived mode hides them
    const group = lastSessions.state?.groups?.[0] as {
      sessions?: { sessionId: string; isArchived: boolean }[];
    };
    expect(group.sessions?.map((s) => [s.sessionId, s.isArchived])).toEqual([
      [inactiveSessionId, true],
    ]);
  });

  it("keeps already registered workspaces and their members unchanged on re-add", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "mine.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const otherCwd = join(root, "other");
    await writeJsonl(join(sessionDir, encodeCwdDirName(otherCwd)), "theirs.jsonl", [
      header({ id: inactiveSessionId, cwd: otherCwd }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    expect(addActiveSession(statePath, root, activeSessionId).ok).toBe(true);
    expect(addActiveSession(statePath, otherCwd, inactiveSessionId).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "addWorkspace", path: root });

    const store = readStore(statePath);
    expect(store["active-workspaces"][root]).toEqual({
      "active-sessions": { [activeSessionId]: {} }, // members survive
    });
    expect(store["active-workspaces"][otherCwd]).toEqual({
      "active-sessions": { [inactiveSessionId]: {} }, // other cwd: untouched
    });
    expect(registeredWorkspaceCwds(store)).toEqual([root, otherCwd]);
  });

  it("does not rewrite the store for an already registered workspace", async () => {
    const { provider, statePath } = createProvider({});
    expect(registerWorkspace(statePath, root).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const writesBefore = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await webview.receive({ type: "addWorkspace", path: `${root}/` });

    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]); // never rewritten
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(writesBefore + 1); // the refreshed list closes the form
  });

  it("keeps a registered sessionless workspace in the refreshed list", async () => {
    const folder = join(root, "registered");
    const { provider, statePath } = createProvider({});
    expect(registerWorkspace(statePath, folder).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: { cwd: string }[] } };
    expect(lastSessions.state?.groups?.map((group) => group.cwd)).toEqual([folder]);
  });

  it("unregisters a requested workspace and drops its empty group", async () => {
    const folder = join(root, "registered");
    const { provider, statePath } = createProvider({});
    expect(registerWorkspace(statePath, folder).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "unregisterWorkspace", cwd: folder });

    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([]);
    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: unknown[] } };
    expect(lastSessions.state?.groups).toEqual([]);
  });

  it("answers an unregister for an unregistered cwd with the unchanged list", async () => {
    const { provider, statePath } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsBefore = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await webview.receive({ type: "unregisterWorkspace", cwd: join(root, "unregistered") });

    expect(existsSync(statePath)).toBe(false); // no store write happened
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsBefore + 1); // the refreshed list still goes out
  });

  it("does not open a terminal or mark active when the session cwd is missing", async () => {
    const sessionDir = join(root, "sessions");
    const cwd = join(root, "missing");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "old.jsonl", [
      header({ id: inactiveSessionId, cwd }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    const store = readStore(statePath);
    expect(activeSessionIds(store).has(inactiveSessionId)).toBe(false);
    expect(Object.keys(store["active-workspaces"])).toEqual([root]);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to open session ${inactiveSessionId} in ${cwd}:`),
    );
  });

  async function selectionFixture() {
    const fixture = await archiveFixture();
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), "third.jsonl", [
      header({ id: unknownSessionId, cwd: root }),
    ]);
    await fixture.provider.refresh();
    const shown: (string | undefined)[] = [];
    fixture.terminal.show.mockImplementation(() => {
      shown.push(fixture.registry.displayedSessionId);
    });
    vscodeMocks.createTerminal.mockImplementation((options) => {
      fixture.mocks.open({ sessionId: options.shellArgs[1], cwd: options.cwd.fsPath });
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
      const sessionIds = [activeSessionId, inactiveSessionId, unknownSessionId];
      setUpStore(statePath, root, archived ? [] : sessionIds);
      if (archived) {
        expect(
          archiveSessions(
            statePath,
            sessionIds.map((sessionId) => ({ sessionId, cwd: root })),
          ).ok,
        ).toBe(true);
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
      expect(mocks.open.mock.calls.map(([session]) => session.sessionId)).toEqual([
        activeSessionId,
        unknownSessionId,
      ]);
      expect(shown).toEqual([activeSessionId, unknownSessionId]);
      expect(validateFile.mock.calls.map(([path]) => path)).toEqual([
        filePath,
        join(root, "sessions", encodeCwdDirName(root), "third.jsonl"),
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
    const { webview, mocks, shown } = await selectionFixture();
    const firstOpening = holdNextOpen(mocks);
    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await firstOpening.started;
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    const third = webview.receive({ type: "openSession", sessionId: unknownSessionId });
    const thirdOpening = holdNextOpen(mocks);
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
    mocks.resolveTarget.mockRejectedValueOnce(new Error("target lookup failed"));
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
      const { registry, statePath, mocks } = await selectionFixture();
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
        statePath,
        startNewSession: async () => {
          await registry.run(async () => {
            events.push("newSession");
          });
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
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "second.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const terminal = {
      creationOptions: { cwd: { fsPath: root } },
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    const { store, mux, mocks, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store), mux);
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
    mockTerminal(mocks, terminal);
    let finishOpening: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    mocks.list.mockImplementationOnce(async () => {
      await opening;
      return [...live.values()].map((runtime) => ({
        id: runtime.sessionId,
        cwd: runtime.cwd,
        file: null,
        phase: null,
      }));
    });
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    finishOpening();
    await Promise.all([first, second]);

    expect(mocks.resolveTarget.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      activeSessionId,
      inactiveSessionId,
    ]);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.show).toHaveBeenCalledTimes(2);
  });

  it.each(["list", "switchClient"] as const)(
    "keeps archived metadata unchanged when tmux %s fails",
    async (method) => {
      const sessionDir = join(root, "sessions");
      await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "saved.jsonl", [
        header({ id: inactiveSessionId, cwd: root }),
      ]);
      const { store, mux, mocks, live, client } = fakeRuntimes();
      const registry = new TerminalRegistry(store, editorTerminals(store), mux);
      const terminal = { processId: Promise.resolve(123), show: vi.fn(), dispose: vi.fn() };
      terminal.dispose.mockImplementation(() => registry.onTerminalClosed(terminal as never));
      vscodeMocks.createTerminal.mockReturnValue(terminal);
      const { provider, statePath } = createProvider({ sessionDir, registry });
      setUpStore(statePath, root, [activeSessionId]);
      expect(archiveSessions(statePath, [{ sessionId: inactiveSessionId, cwd: root }]).ok).toBe(
        true,
      );
      const webview = createView();
      provider.resolveWebviewView(webview.view as never);
      await provider.refresh();
      const before = await readFile(statePath, "utf8");
      if (method === "list") {
        mocks.list.mockRejectedValueOnce(new Error("tmux permission denied"));
      } else {
        live.set(inactiveSessionId, {
          sessionId: inactiveSessionId,
          cwd: root,
          target: `pi-${inactiveSessionId}`,
        });
        mocks.switchClient.mockRejectedValueOnce(new Error("tmux permission denied"));
        mockTerminal(mocks, terminal);
        mocks.clients.mockImplementationOnce(async () => {
          client.target = "different-target";
          return [client];
        });
      }

      await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(inactiveSessionId),
      );
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(root));
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("tmux permission denied"),
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
    setUpStore(statePath, root, [activeSessionId]);
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

  it("shows an error and sends no list when the session directory is unreadable", async () => {
    const notADir = join(root, "not-a-dir");
    await writeFile(notADir, "x", "utf8");
    const { provider } = createProvider({ sessionDir: notADir });
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

  it("shows an error and sends no list when the metadata store is invalid", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const statePath = join(root, "session-state.json");
    await writeFile(statePath, "{ invalid", "utf8");
    const { provider } = createProvider({ sessionDir, statePath });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(
      /^session-state\.json is not valid JSON: /,
    );
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(false);
  });

  it("shows an error and keeps the list when an archive write fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await vi.waitFor(() => {
      expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(true);
    });
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(
      /^session-state\.json is not valid JSON: /,
    );
    const errorCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "error",
    ).length;
    expect(errorCalls).toBe(1);
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);
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

  it("stops the confirmed conversation before removing membership and retains its source", async () => {
    const { webview, statePath, registry, terminal, live, mocks, filePath } =
      await archiveFixture();
    const source = await readFile(filePath, "utf8");
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    mocks.open({ sessionId: inactiveSessionId, cwd: root });
    const otherRuntime = live.get(inactiveSessionId);
    const stop = mocks.stop.getMockImplementation()!;
    mocks.stop.mockImplementationOnce(async (sessionId) => {
      expect(activeSessionIds(readStore(statePath)).has(sessionId)).toBe(true);
      return stop(sessionId);
    });

    await webview.receive({
      type: "archiveSession",
      sessionId: activeSessionId,
      target: "arbitrary",
      pid: 1,
    });

    expect(mocks.stop).toHaveBeenCalledWith(activeSessionId);
    expect(live.has(activeSessionId)).toBe(false);
    expect(live.get(inactiveSessionId)).toBe(otherRuntime);
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([inactiveSessionId]));
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(registry.displayedSessionId).toBeUndefined();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.displayedSessionId).toBeUndefined();
    expect(await readFile(filePath, "utf8")).toBe(source);

    const startsBefore = mocks.open.mock.calls.length;
    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });
    // unarchive reopens the stored conversation: Pi starts again from the same source
    expect(mocks.open).toHaveBeenCalledTimes(startsBefore + 1);
    expect(mocks.open).toHaveBeenLastCalledWith({ sessionId: activeSessionId, cwd: root });
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

  it("leaves membership and display unchanged when runtime stop fails", async () => {
    const { webview, statePath, mocks, terminal, registry } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    mocks.stop.mockRejectedValueOnce(new Error("stop denied"));
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe(activeSessionId);
    expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/Failed to stop Pi session .*stop denied/),
    );
  });

  it("keeps the stopped display cleared and reports a later archive write failure", async () => {
    const { webview, statePath, mocks, live, registry } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    const before = await readFile(statePath, "utf8");
    const stop = mocks.stop.getMockImplementation()!;
    mocks.stop.mockImplementationOnce(async (sessionId) => {
      const target = await stop(sessionId);
      await chmod(root, 0o500);
      return target;
    });
    try {
      await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(live.has(activeSessionId)).toBe(false);
      expect(registry.displayedSessionId).toBeUndefined();
      const lastState = webview.postMessage.mock.calls
        .filter(([message]) => message.type === "sessions")
        .at(-1)?.[0].state;
      expect(lastState.displayedSessionId).toBeUndefined();
      expect(
        lastState.groups[0].sessions.find(
          (session: { sessionId: string }) => session.sessionId === activeSessionId,
        ).isArchived,
      ).toBe(false);
      expect(vscodeMocks.showErrorMessage).toHaveBeenLastCalledWith(
        expect.stringMatching(/stopped, but failed to save archive: .*EACCES/),
      );
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("does not stop a runtime for an unknown session or an unreadable state store", async () => {
    const { webview, statePath, mocks } = await archiveFixture();
    const before = await readFile(statePath, "utf8");
    await webview.receive({ type: "archiveSession", sessionId: unknownSessionId });
    expect(await readFile(statePath, "utf8")).toBe(before);
    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledTimes(2);
  });

  it("serializes archive and a later All open without forbidding archived runtimes", async () => {
    const { webview, statePath, mocks, live } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    let release!: () => void;
    const pendingStop = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = mocks.stop.getMockImplementation()!;
    mocks.stop.mockImplementationOnce(async (sessionId) => {
      await pendingStop;
      return stop(sessionId);
    });
    const archived = webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    const opened = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([archived, opened]);
    expect(activeSessionIds(readStore(statePath)).has(activeSessionId)).toBe(false);
    expect(live.has(activeSessionId)).toBe(true);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
