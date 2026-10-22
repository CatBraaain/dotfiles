import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readMetadataStore, setSessionActive } from "../src/metadataStore";
import { TerminalRegistry } from "../src/terminalRegistry";
import { SessionWebviewProvider } from "../src/webview/sessionWebviewProvider";
import { cleanup, header, tempDir, writeJsonl } from "./fixtures";
import { followWorkTarget } from "../src/workTarget";

vi.mock("../src/workTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workTarget")>()),
  followWorkTarget: vi.fn().mockResolvedValue(undefined),
}));

const vscodeMocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  showErrorMessage: vi.fn(),
  clipboardWriteText: vi.fn(),
  activeTextEditor: undefined as undefined | { document: { uri: { fsPath: string } } },
  executeCommand: vi.fn(),
  openRepository: vi.fn(),
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
  workspace: { getWorkspaceFolder: () => ({}) },
  commands: { executeCommand: vscodeMocks.executeCommand },
  extensions: {
    getExtension: () => ({
      activate: async () => ({ getAPI: () => ({ openRepository: vscodeMocks.openRepository }) }),
    }),
  },
}));

const activeSessionId = "00000000-0000-4000-8000-000000000001";
const inactiveSessionId = "00000000-0000-4000-8000-000000000002";
let root: string;

beforeEach(async () => {
  root = await tempDir("pi-webview-provider-test-");
  vi.mocked(followWorkTarget).mockReset().mockResolvedValue(undefined);
  vscodeMocks.createTerminal.mockReset();
  vscodeMocks.showErrorMessage.mockReset();
  vscodeMocks.clipboardWriteText.mockReset();
  vscodeMocks.activeTextEditor = undefined;
  vscodeMocks.executeCommand.mockReset();
  vscodeMocks.openRepository.mockReset();
});

afterEach(async () => {
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

function createProvider(deps: Partial<ConstructorParameters<typeof SessionWebviewProvider>[0]> = {}) {
  const metadataPath = deps.metadataPath ?? join(root, "session-metadata.json");
  const provider = new SessionWebviewProvider({
    extensionUri: root,
    sessionDir: join(root, "sessions"),
    registry: new TerminalRegistry(),
    startNewSession: async () => {},
    ...deps,
    metadataPath,
  } as ConstructorParameters<typeof SessionWebviewProvider>[0]);
  return { provider, metadataPath };
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

  it("sends every session with active marks and refreshes after archiving", async () => {
    const sessionDir = join(root, "sessions");
    const activePath = await writeJsonl(join(sessionDir, "project"), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    await writeJsonl(join(sessionDir, "project"), "inactive.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const { provider, metadataPath } = createProvider({ sessionDir });
    expect(setSessionActive(metadataPath, activeSessionId, true).ok).toBe(true);

    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(2);
    await webview.receive({ type: "setMode", mode: "all" });
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(2);

    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });
    const metadata = readMetadataStore(metadataPath);
    expect(metadata.status === "ok" && metadata.data.sessions?.[activeSessionId].active).toBe(false);
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isActive).toBe(false);
    await expect(rm(activePath)).resolves.toBeUndefined();
  });

  it("reflects disk changes on refresh without automatic updates", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const { provider } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await vi.waitFor(() => {
      expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(true);
    });
    const sessionsCalls = webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions").length;
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(1);

    await writeJsonl(join(sessionDir, "project"), "second.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    // No file watcher: the displayed list stays as-is until Refresh arrives.
    expect(webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions")).toHaveLength(sessionsCalls);

    await webview.receive({ type: "refresh" });
    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toHaveLength(2);
  });

  it("resends sessions after the recreated client announces it is ready", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const { provider } = createProvider({ sessionDir });
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
          expect.objectContaining({ cwd: root, sessions: [expect.objectContaining({ sessionId: activeSessionId })] }),
        ],
      },
    });
  });

  it("restores the list after SCM hides the view without requiring Refresh", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const { provider } = createProvider({ sessionDir });
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
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const original = createProvider({ sessionDir });
    expect(setSessionActive(original.metadataPath, activeSessionId, true).ok).toBe(true);
    original.provider.dispose();
    const restored = createProvider({ sessionDir });
    const webview = createView();
    restored.provider.resolveWebviewView(webview.view as never);
    const terminal = { exitStatus: undefined, sendText: vi.fn(), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);

    await webview.receive({ type: "ready" });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions).toEqual([
      expect.objectContaining({ sessionId: activeSessionId, isActive: true }),
    ]);
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(followWorkTarget).toHaveBeenCalledWith(root, undefined);
  });

  it("opens the selected editor change even when Terminal.show clears the active editor", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const first = { fsPath: join(root, "first.ts") };
    const selected = { fsPath: join(root, "selected.ts") };
    vscodeMocks.activeTextEditor = { document: { uri: selected } };
    vscodeMocks.createTerminal.mockReturnValue({
      sendText: vi.fn(),
      show: () => {
        vscodeMocks.activeTextEditor = undefined;
      },
    });
    const actual = await vi.importActual<typeof import("../src/workTarget")>("../src/workTarget");
    vi.mocked(followWorkTarget).mockImplementation(actual.followWorkTarget);
    vscodeMocks.openRepository.mockResolvedValue({
      rootUri: { fsPath: root },
      status: async () => {},
      state: { workingTreeChanges: [{ uri: first }, { uri: selected }], indexChanges: [] },
    });
    const { provider } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.activeTextEditor).toBeUndefined();
    expect(vscodeMocks.executeCommand).toHaveBeenLastCalledWith("git.openChange", selected);
  });

  it("opens an existing session in an editor terminal and reuses it", async () => {
    const sessionDir = join(root, "sessions");
    const filePath = await writeJsonl(join(sessionDir, "project"), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const terminal = { exitStatus: undefined, sendText: vi.fn(), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const { provider, metadataPath } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledWith({
      name: "Untitled",
      cwd: { fsPath: root },
      location: 1,
    });
    expect(terminal.sendText).toHaveBeenCalledWith(`pi --session "${filePath}"`, true);
    expect(terminal.show).toHaveBeenCalledTimes(2);
    expect(followWorkTarget).toHaveBeenCalledTimes(2);
    expect(followWorkTarget).toHaveBeenLastCalledWith(root, undefined);
    const metadata = readMetadataStore(metadataPath);
    expect(metadata.status === "ok" && metadata.data.sessions?.[activeSessionId].active).toBe(true);
  });

  it("does not open a terminal when the selected session file disappeared", async () => {
    const sessionDir = join(root, "sessions");
    const filePath = await writeJsonl(join(sessionDir, "project"), "active.jsonl", [
      header({ id: activeSessionId, cwd: root }),
    ]);
    const { provider } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    await rm(filePath);

    await webview.receive({ type: "openSession", sessionId: activeSessionId });

    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(`Session file no longer exists: ${activeSessionId}`);
  });

  it("starts a new session only when the fixed protocol requests it", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await webview.receive({ type: "newSession" });
    await webview.receive({ type: "shell", command: "pi" });

    expect(startNewSession).toHaveBeenCalledTimes(1);
  });

  it("passes saved cwd candidates to the new-session picker", async () => {
    const startNewSession = vi.fn().mockResolvedValue(undefined);
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "old.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const { provider } = createProvider({ sessionDir, startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "newSession" });

    expect(startNewSession).toHaveBeenCalledWith([root]);
  });

  it("displays a launch error without changing the list", async () => {
    const startNewSession = vi.fn().mockRejectedValue(new Error("Work folder missing"));
    const { provider } = createProvider({ startNewSession });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsBefore = webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions").length;

    await webview.receive({ type: "newSession" });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to start Pi session: Work folder missing");
    expect(webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions")).toHaveLength(sessionsBefore);
  });

  it("does not open a terminal or mark active when the session cwd is missing", async () => {
    const sessionDir = join(root, "sessions");
    const cwd = join(root, "missing");
    await writeJsonl(join(sessionDir, "project"), "old.jsonl", [header({ id: inactiveSessionId, cwd })]);
    const { provider, metadataPath } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

    expect(vscodeMocks.createTerminal).not.toHaveBeenCalled();
    expect(readMetadataStore(metadataPath).status).toBe("empty");
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open session work folder:"),
    );
    expect(followWorkTarget).not.toHaveBeenCalled();
  });

  it("keeps the opened terminal and active mark when native navigation fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "old.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const terminal = { exitStatus: undefined, sendText: vi.fn(), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    vi.mocked(followWorkTarget).mockRejectedValueOnce(new Error("Git disabled"));
    const { provider, metadataPath } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: inactiveSessionId });

    const metadata = readMetadataStore(metadataPath);
    expect(metadata.status === "ok" && metadata.data.sessions?.[inactiveSessionId].active).toBe(true);
    expect(terminal.show).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to show session files or changes: Git disabled");
  });

  it("processes overlapping conversation selections in arrival order", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "first.jsonl", [header({ id: activeSessionId, cwd: root })]);
    await writeJsonl(join(sessionDir, "project"), "second.jsonl", [header({ id: inactiveSessionId, cwd: root })]);
    const terminal = { exitStatus: undefined, sendText: vi.fn(), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    let finishNavigation: () => void = () => {};
    const navigating = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    vi.mocked(followWorkTarget).mockReturnValueOnce(navigating);
    const { provider } = createProvider({ sessionDir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    const first = webview.receive({ type: "openSession", sessionId: activeSessionId });
    await vi.waitFor(() => expect(followWorkTarget).toHaveBeenCalledTimes(1));
    const secondEditorUri = { fsPath: join(root, "second-editor.ts") };
    vscodeMocks.activeTextEditor = { document: { uri: secondEditorUri } };
    const second = webview.receive({ type: "openSession", sessionId: inactiveSessionId });
    vscodeMocks.activeTextEditor = undefined;
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
    finishNavigation();
    await Promise.all([first, second]);

    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(2);
    expect(followWorkTarget).toHaveBeenCalledTimes(2);
    expect(followWorkTarget).toHaveBeenLastCalledWith(root, secondEditorUri);
  });

  it("copies the session ID to the clipboard on copySessionId", async () => {
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsCalls = webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions").length;

    await webview.receive({ type: "copySessionId", sessionId: activeSessionId });

    expect(vscodeMocks.clipboardWriteText).toHaveBeenCalledWith(activeSessionId);
    expect(webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions")).toHaveLength(sessionsCalls);
  });

  it("shows an error and keeps the list when the clipboard write fails", async () => {
    const { provider } = createProvider();
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsCalls = webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions").length;
    vscodeMocks.clipboardWriteText.mockRejectedValueOnce(new Error("denied"));

    await webview.receive({ type: "copySessionId", sessionId: activeSessionId });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to copy session ID: denied");
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "error")).toBe(true);
    expect(webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions")).toHaveLength(sessionsCalls);
  });

  it("shows an error and sends no list when the session directory is unreadable", async () => {
    const notADir = join(root, "not-a-dir");
    await writeFile(notADir, "x", "utf8");
    const { provider } = createProvider({ sessionDir: notADir });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(/^Failed to read Pi sessions: /);
    const lastCall = webview.postMessage.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual({ type: "error", message: expect.stringMatching(/^Failed to read Pi sessions: /) });
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(false);
  });

  it("shows an error and sends no list when the metadata store is invalid", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "active.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const metadataPath = join(root, "session-metadata.json");
    await writeFile(metadataPath, "{ invalid", "utf8");
    const { provider } = createProvider({ sessionDir, metadataPath });
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(/^session-metadata\.json is not valid JSON: /);
    expect(webview.postMessage.mock.calls.some((call) => call[0].type === "sessions")).toBe(false);
  });

  it("shows an error and keeps the list when an archive write fails", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "active.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const { provider, metadataPath } = createProvider({ sessionDir });
    expect(setSessionActive(metadataPath, activeSessionId, true).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();
    const sessionsCalls = webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions").length;

    await writeFile(metadataPath, "{ invalid", "utf8");
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });

    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toMatch(/^session-metadata\.json is not valid JSON: /);
    const errorCalls = webview.postMessage.mock.calls.filter((call) => call[0].type === "error").length;
    expect(errorCalls).toBe(1);
    expect(webview.postMessage.mock.calls.filter((call) => call[0].type === "sessions")).toHaveLength(sessionsCalls);
  });

  it("notifies when postMessage reports the webview was not updated", async () => {
    const { provider } = createProvider();
    const webview = createView();
    webview.postMessage.mockResolvedValueOnce(false);
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();
    await vi.waitFor(() => {
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to update the Sessions view.");
    });
  });

  it("notifies when postMessage rejects", async () => {
    const { provider } = createProvider();
    const webview = createView();
    webview.postMessage.mockRejectedValueOnce(new Error("webview gone"));
    provider.resolveWebviewView(webview.view as never);

    await provider.refresh();
    await vi.waitFor(() => {
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith("Failed to update the Sessions view.");
    });
  });

  it("keeps the terminal alive after archiving its session", async () => {
    const sessionDir = join(root, "sessions");
    await writeJsonl(join(sessionDir, "project"), "active.jsonl", [header({ id: activeSessionId, cwd: root })]);
    const terminal = { exitStatus: undefined, sendText: vi.fn(), show: vi.fn() };
    vscodeMocks.createTerminal.mockReturnValue(terminal);
    const registry = new TerminalRegistry();
    const { provider, metadataPath } = createProvider({ sessionDir, registry });
    expect(setSessionActive(metadataPath, activeSessionId, true).ok).toBe(true);
    const webview = createView();
    provider.resolveWebviewView(webview.view as never);
    await provider.refresh();

    await webview.receive({ type: "openSession", sessionId: activeSessionId });
    await webview.receive({ type: "archiveSession", sessionId: activeSessionId });

    expect(webview.postMessage.mock.calls.at(-1)?.[0].state.groups[0].sessions[0].isActive).toBe(false);
    expect(registry.get(activeSessionId)).toBe(terminal);
    expect(vscodeMocks.createTerminal).toHaveBeenCalledTimes(1);
  });
});
