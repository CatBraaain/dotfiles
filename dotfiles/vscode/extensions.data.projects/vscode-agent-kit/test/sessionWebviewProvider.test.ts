import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activeSessionIds,
  addActiveSession,
  archivedSessionNames,
  archiveSessions,
  lockedSessionIds,
  mutateSessionStateStore,
  readSessionStateStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  setSessionLocks,
  type SessionStateStoreData,
} from "../src/metadataStore";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { encodeCwdDirName } from "../src/paths";
import { fakeRuntimes } from "./runtimeFixtures";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
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
    legacyMetadataPath: join(root, "session-metadata.json"),
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

describe("SessionWebviewProvider", () => {
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

    await webview.receive({ type: "archiveSessions", sessionIds: [activeSessionId] });

    const store = readStore(statePath);
    // archiving removes the whitelist entry and stores the display name as the snapshot
    expect(activeSessionIds(store).has(activeSessionId)).toBe(false);
    expect(archivedSessionNames(store).get(activeSessionId)).toBe("Untitled");
    expect(
      sentSessions().find((session) => session.sessionId === activeSessionId)?.isArchived,
    ).toBe(true);
  });

  it("archives a requested batch in one write, skipping locked sessions", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "second.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId, inactiveSessionId]);
    expect(
      setSessionLocks(statePath, [{ sessionId: activeSessionId, cwd: root, locked: true }]).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({
      type: "archiveSessions",
      sessionIds: [activeSessionId, inactiveSessionId],
    });

    const store = readStore(statePath);
    expect(lockedSessionIds(store).has(activeSessionId)).toBe(true);
    expect(activeSessionIds(store).has(inactiveSessionId)).toBe(false);
    const sentSessions = webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions as {
      sessionId: string;
      isArchived: boolean;
      isLocked: boolean;
    }[];
    expect(sentSessions.find((session) => session.sessionId === activeSessionId)).toMatchObject({
      isArchived: false,
      isLocked: true,
    });
  });

  it("rejects an archive batch with an unknown session id without writing", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({
      type: "archiveSessions",
      sessionIds: [activeSessionId, unknownSessionId],
    });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
    );
    // the failed batch wrote nothing: the whitelist keeps its previous content
    const store = readStore(statePath);
    expect(registeredWorkspaceCwds(store)).toEqual([root]);
    expect(activeSessionIds(store)).toEqual(new Set([activeSessionId]));
  });

  it("persists lock and unlock requests and refreshes the marks", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "setSessionLock", sessionId: activeSessionId, locked: true });

    const store = readStore(statePath);
    expect(lockedSessionIds(store).has(activeSessionId)).toBe(true);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isLocked).toBe(
      true,
    );

    await webview.receive({ type: "setSessionLock", sessionId: activeSessionId, locked: false });

    const unlocked = readStore(statePath);
    expect(lockedSessionIds(unlocked).has(activeSessionId)).toBe(false);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isLocked).toBe(
      false,
    );
  });

  it("shows an error and keeps the list when the lock write fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await vi.waitFor(() =>
      expect(
        webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
      ).toHaveLength(2),
    );
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await writeFile(statePath, "{ invalid", "utf8");
    await webview.receive({ type: "setSessionLock", sessionId: activeSessionId, locked: true });

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(
      /^session-state\.json is not valid JSON: /,
    );
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);
  });

  it("migrates the v1 metadata store into the session state store on first refresh", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "visible.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "archived.jsonl", [
      header({ id: inactiveSessionId, cwd: root }),
    ]);
    const legacyMetadataPath = join(root, "session-metadata.json");
    await writeFile(
      legacyMetadataPath,
      JSON.stringify({
        version: 1,
        sessions: {
          [activeSessionId]: { active: true },
          [inactiveSessionId]: { active: false, name: "Archived display name" },
        },
        workspaces: { [root]: { addedAtMs: 1 } },
      }),
      "utf8",
    );
    const { provider, statePath } = createProvider({ sessionDir, legacyMetadataPath });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const store = readStore(statePath);
    expect(store["migrated-v1"]).toBe(true);
    expect(registeredWorkspaceCwds(store)).toEqual([root]);
    expect(activeSessionIds(store)).toEqual(new Set([activeSessionId]));
    expect(archivedSessionNames(store).get(inactiveSessionId)).toBe("Archived display name");
    const groups = webview.postMessage.mock.calls.at(-1)?.[0].state.groups as {
      cwd: string;
      workspaceActive: boolean;
      sessions: { sessionId: string; isArchived: boolean }[];
    }[];
    expect(groups.map((group) => [group.cwd, group.workspaceActive])).toEqual([[root, true]]);
    // rows sort by mtime, newest first: the archived file was written last
    expect(groups[0].sessions.map((session) => [session.sessionId, session.isArchived])).toEqual([
      [inactiveSessionId, true],
      [activeSessionId, false],
    ]);
  });

  it("carries the workspace view toggle into the group payload", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    await mutateSessionStateStore(statePath, (store) => {
      store.workspaces[root] = { ...store.workspaces[root], active: false };
      return true;
    });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const groups = webview.postMessage.mock.calls.at(-1)?.[0].state.groups as {
      cwd: string;
      workspaceActive: boolean;
    }[];
    expect(groups.map((group) => [group.cwd, group.workspaceActive])).toEqual([[root, false]]);
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
    expect(
      archiveSessions(statePath, [
        { sessionId: activeSessionId, cwd: root, displayName: "Old name" },
      ]).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    const store = readStore(statePath);
    // opening does not unarchive: the session stays out of the whitelist and
    // its display-name snapshot stays untouched
    expect(activeSessionIds(store).has(activeSessionId)).toBe(false);
    expect(archivedSessionNames(store).get(activeSessionId)).toBe("Old name");
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );
    expect(terminal.show).toHaveBeenCalledTimes(1);
  });

  it("unarchives requested archived sessions and refreshes the list", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    expect(
      archiveSessions(statePath, [
        { sessionId: activeSessionId, cwd: root, displayName: "Old name" },
      ]).ok,
    ).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isArchived).toBe(
      true,
    );

    await webview.receive({ type: "unarchiveSessions", sessionIds: [activeSessionId] });

    const store = readStore(statePath);
    // unarchiving drops the display-name snapshot so the next scan re-reads it
    expect(activeSessionIds(store).has(activeSessionId)).toBe(true);
    expect(archivedSessionNames(store).has(activeSessionId)).toBe(false);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0]).toMatchObject({
      sessionId: activeSessionId,
      isArchived: false,
    });
  });

  it("rejects an unarchive batch with an unknown session id without writing", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "first.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    setUpStore(statePath, root, [activeSessionId]);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({
      type: "unarchiveSessions",
      sessionIds: [activeSessionId, unknownSessionId],
    });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      `Session not found: ${unknownSessionId}`,
    );
    // the failed batch wrote nothing: the whitelist keeps its previous content
    const store = readStore(statePath);
    expect(registeredWorkspaceCwds(store)).toEqual([root]);
    expect(activeSessionIds(store)).toEqual(new Set([activeSessionId]));
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
    // opening does not archive or unarchive: the store is unchanged
    const store = readStore(statePath);
    expect(registeredWorkspaceCwds(store)).toEqual([root]);
    expect(activeSessionIds(store)).toEqual(new Set([activeSessionId]));
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
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      "registered-workspaces"?: string[];
    };
    expect(parsed["registered-workspaces"]).toEqual([folder]);
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

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      "registered-workspaces": string[];
    };
    expect(parsed["registered-workspaces"]).toEqual([folder]);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups).toEqual([
      expect.objectContaining({ cwd: folder, registered: true }),
    ]);
  });

  it("keeps an existing registration unchanged when adding a tilde input", async () => {
    const path = "~/registered/./";
    vi.stubEnv("HOME", root);
    const folder = join(root, "registered");
    await mkdir(folder);
    const { provider, statePath } = createProvider();
    expect(registerWorkspace(statePath, folder).ok).toBe(true);
    const original = await readFile(statePath, "utf8");
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "addWorkspace", path });

    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups).toEqual([
      expect.objectContaining({ cwd: folder, registered: true }),
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
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
      "registered-workspaces": string[];
    };
    const [storedCwd] = parsed["registered-workspaces"];
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

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SessionStateStoreData;
    expect(parsed["registered-workspaces"]).toHaveLength(1); // the store was written
    // the fresh registration archives the workspace's existing sessions with a snapshot
    expect(parsed.workspaces[root]).toEqual({
      "archived-names": { [inactiveSessionId]: "Untitled" },
    });
    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: { cwd: string; registered: boolean }[] } };
    expect(lastSessions.state?.groups).toEqual([
      expect.objectContaining({ cwd: root, registered: true }),
    ]);
    // archived sessions exist in the payload; the webview's default Unarchived mode hides them
    const group = lastSessions.state?.groups?.[0] as {
      sessions?: { sessionId: string; isArchived: boolean }[];
    };
    expect(group.sessions?.map((s) => [s.sessionId, s.isArchived])).toEqual([
      [inactiveSessionId, true],
    ]);
  });

  it("archives only the new workspace's own sessions, keeping other cwds untouched", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "mine.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const otherCwd = join(root, "other");
    await writeJsonl(join(sessionDir, encodeCwdDirName(otherCwd)), "theirs.jsonl", [
      header({ id: inactiveSessionId, cwd: otherCwd }),
    ]);
    const { provider, statePath } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "addWorkspace", path: root });

    const store = readStore(statePath);
    expect(activeSessionIds(store).has(activeSessionId)).toBe(false);
    expect(archivedSessionNames(store).get(activeSessionId)).toBe("Untitled");
    expect(registeredWorkspaceCwds(store)).toEqual([root]); // other cwd: untouched
  });

  it("does not archive sessions again when adding an already registered workspace", async () => {
    const { provider, statePath } = createProvider({});
    expect(registerWorkspace(statePath, root).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "addWorkspace", path: `${root}/` });

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SessionStateStoreData;
    expect(parsed.workspaces).toEqual({}); // no archive on re-add
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

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SessionStateStoreData;
    expect(parsed["registered-workspaces"]).toEqual([root]); // never rewritten
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(writesBefore + 1); // the refreshed list closes the form
  });

  it("keeps a registered sessionless workspace in the refreshed list", async () => {
    const folder = join(root, "registered");
    const { provider, statePath } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await registerWorkspace(statePath, folder);

    await provider.refresh();

    const lastSessions = webview.postMessage.mock.calls
      .map((call) => call[0])
      .filter((message: { type?: string }) => message.type === "sessions")
      .at(-1) as { state?: { groups?: { cwd: string; registered: boolean }[] } };
    expect(lastSessions.state?.groups?.map((group) => [group.cwd, group.registered])).toEqual([
      [folder, true],
    ]);
  });

  it("unregisters a requested workspace and drops its empty group", async () => {
    const folder = join(root, "registered");
    const { provider, statePath } = createProvider({});
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await registerWorkspace(statePath, folder);
    await provider.refresh();

    await webview.receive({ type: "unregisterWorkspace", cwd: folder });

    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SessionStateStoreData;
    expect(parsed["registered-workspaces"]).toEqual([]);
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

    await expect(readFile(statePath, "utf8")).rejects.toThrow(); // no store was created
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
    expect(Object.keys(store.workspaces)).toEqual([root]);
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
      expect(
        archiveSessions(statePath, [
          { sessionId: inactiveSessionId, cwd: root, displayName: "Saved" },
        ]).ok,
      ).toBe(true);
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

  it("copies the session ID to the clipboard on copySessionId", async () => {
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;

    await webview.receive({ type: "copySessionId", sessionId: activeSessionId });

    expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledWith(activeSessionId);
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);
  });

  it("shows an error and keeps the list when the clipboard write fails", async () => {
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsCalls = webview.postMessage.mock.calls.filter(
      (call) => call[0].type === "sessions",
    ).length;
    vscodeMocks.clipboardWriteText.mockRejectedValueOnce(new Error("denied"));

    await webview.receive({ type: "copySessionId", sessionId: activeSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to copy session ID: denied");
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "error")).toBe(true);
    expect(
      webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions"),
    ).toHaveLength(sessionsCalls);
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
      type: "error",
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
    await webview.receive({ type: "archiveSessions", sessionIds: [activeSessionId] });

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

  it("keeps the terminal alive after archiving its session", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, encodeCwdDirName(root)), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = {
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
    await webview.receive({ type: "archiveSessions", sessionIds: [activeSessionId] });

    const sentSessions = webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions as {
      sessionId: string;
      isArchived: boolean;
    }[];
    expect(sentSessions.find((session) => session.sessionId === activeSessionId)?.isArchived).toBe(
      true,
    );
    expect(
      await registry.runtimes.isAlive({
        sessionId: activeSessionId,
        cwd: root,
        target: `pi-${activeSessionId}`,
      }),
    ).toBe(true);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
  });
});
