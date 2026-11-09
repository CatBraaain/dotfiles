import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { encodeCwdDirName } from "../src/paths";
import { fakeRuntimes } from "./runtimeFixtures";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
import type { SessionPhase, WebviewState } from "../src/webview/protocol";
import { cleanup, header, tempDir, writeJsonl } from "./fixtures";
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

function createRegistry() {
  const { store } = fakeRuntimes();
  return new TerminalRegistry(store, editorTerminals(store));
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
  const registry = new TerminalRegistry(runtimes.store, editorTerminals(runtimes.store));
  const terminal = {
    creationOptions: { cwd: root },
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(() => registry.onTerminalClosed(terminal as never)),
  };
  vscodeMocks.createTerminal.mockReturnValue(terminal);
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
  const { store, mocks } = fakeRuntimes();
  const registry = new TerminalRegistry(store, editorTerminals(store));
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

  it("sends the live phase of a session whose tmux pane exists", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store));
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

  it("drops the phase of a session whose tmux pane is gone (stale sweep)", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store)); // no live pane
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

  it("sends no phase when the tmux query fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { store, mocks, live } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store));
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
        mocks.ensure.mockRejectedValueOnce(new Error("cannot attach"));

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
      const { provider, statePath, store, setPhase, row, sentState } = await unreadFixture();
      await setPhase("running");
      await setPhase("waiting-user");
      expect(row().hasUnread).toBe(true);
      provider.dispose();

      const { provider: replacement } = createProvider({
        statePath,
        registry: new TerminalRegistry(store, editorTerminals(store)),
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

    it("keeps tracking a running session selected during a transient tmux query failure", async () => {
      const { mocks, webview, setPhase, row } = await unreadFixture();
      await setPhase("running");
      mocks.aliveSessionIds.mockResolvedValueOnce(null);

      await webview.receive({ type: "openSession", sessionId: activeSessionId });
      await setPhase("waiting-user");
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it("preserves unread through a transient tmux query failure until recovery", async () => {
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

    it("preserves an observed run when its completion cannot yet be checked against tmux", async () => {
      const { provider, mocks, setPhase, row } = await unreadFixture();
      await setPhase("running");
      mocks.aliveSessionIds.mockResolvedValueOnce(null);
      await setPhase("waiting-user");
      expect(row().state).toBeUndefined();

      await provider.refresh();
      expect(row()).toMatchObject({ state: "waiting-user", hasUnread: true });
    });

    it.each(["missing-phase", "dead-pane"] as const)(
      "forgets a run and unread after %s rather than notifying again",
      async (reason) => {
        const { provider, live, setPhase, row } = await unreadFixture();
        await setPhase("running");
        await setPhase("waiting-user");
        expect(row().hasUnread).toBe(true);

        if (reason === "missing-phase") await setPhase(undefined);
        if (reason === "dead-pane") {
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
    const restored = createProvider({ sessionDir });
    const webview = createView();
    restored.provider.resolveWebviewView(webview.view as never);
    const terminal = {
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    vscodeMocks.createTerminal.mockReturnValue(terminal);

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
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const { provider, statePath } = createProvider({ sessionDir });
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
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const { provider, statePath } = createProvider({ sessionDir });
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

  it("unarchives a requested archived session and refreshes the list", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
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
  });

  it("rejects an unarchive request for an unknown session id without writing", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "unarchiveSession", sessionId: unknownSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
    );
    // the failed request wrote nothing: the settings and the store keep their previous content
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
  });

  it("opens an unregistered cwd directly in Pi without workbench side effects", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = { processId: Promise.resolve(123), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const { provider, statePath } = createProvider({ sessionDir });
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
    const filePath = await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = {
      creationOptions: { cwd: { fsPath: root } },
      exitStatus: undefined,
      processId: Promise.resolve(123),
      sendText: vi.fn(),
      show: vi.fn(),
    };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const registry = createRegistry();
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
        shellPath: "tmux",
      }),
    );
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(registry.runtimes.ensure).toHaveBeenCalledWith({
      sessionId: activeSessionId,
      cwd: root,
      args: ["--session", filePath],
    });
    expect(terminal.show).toHaveBeenCalledTimes(2);
    // opening does not archive or unarchive: the settings and the store are unchanged
    expect(registeredWorkspaceCwds(readStore(statePath))).toEqual([root]);
    expect(activeSessionIds(readStore(statePath))).toEqual(new Set([activeSessionId]));
  });

  it("does not open a terminal when the selected session file disappeared", async () => {
    const sessionDir = join(root, "sessions");
    const filePath = await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await rm(filePath);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session file no longer exists: ${activeSessionId}`,
    );
  });

  it("starts a new session only when the fixed protocol requests it", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const { provider, statePath } = createProvider({ startNewSession });
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

  it("processes overlapping conversation selections in arrival order", async () => {
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
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const { store, mocks } = fakeRuntimes();
    const registry = new TerminalRegistry(store, editorTerminals(store));
    let finishOpening: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    mocks.ensure.mockImplementationOnce(async (launch) => {
      await opening;
      return { sessionId: launch.sessionId, cwd: launch.cwd, target: `pi-${launch.sessionId}` };
    });
    const { provider, statePath } = createProvider({ sessionDir, registry });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(mocks.ensure).toHaveBeenCalledTimes(1));
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    finishOpening();
    await Promise.all([first, second]);

    expect(mocks.ensure.mock.calls.map(([launch]) => launch.sessionId)).toEqual([
      activeSessionId,
      inactiveSessionId,
    ]);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(terminal.show).toHaveBeenCalledTimes(2);
  });

  it.each(["ensure", "switchClient"] as const)(
    "keeps archived metadata unchanged when tmux %s fails",
    async (method) => {
      const sessionDir = join(root, "sessions");
      await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "saved.jsonl", [
        header({ id: inactiveSessionId, cwd: root }),
      ]);
      const { store, mocks } = fakeRuntimes();
      const registry = new TerminalRegistry(store, editorTerminals(store));
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
      mocks[method].mockRejectedValueOnce(new Error("tmux permission denied"));

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
    await mocks.ensure({ sessionId: inactiveSessionId, cwd: root, args: [] });
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

    const startsBefore = mocks.ensure.mock.calls.length;
    await webview.receive({ type: "unarchiveSession", sessionId: activeSessionId });
    expect(mocks.ensure).toHaveBeenCalledTimes(startsBefore);
    expect(live.has(activeSessionId)).toBe(false);
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    expect(mocks.ensure).toHaveBeenLastCalledWith({
      sessionId: activeSessionId,
      cwd: root,
      args: ["--session", filePath],
    });
  });

  it("archives a background conversation while preserving another display and selection", async () => {
    const { webview, terminal, registry, live } = await archiveFixture();
    await webview.receive({ type: "openSession", sessionId: activeSessionId });
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
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([archived, opened]);
    expect(activeSessionIds(readStore(statePath)).has(activeSessionId)).toBe(false);
    expect(live.has(activeSessionId)).toBe(true);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });
});
