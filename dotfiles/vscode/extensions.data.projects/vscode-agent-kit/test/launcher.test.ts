import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionLauncher } from "../src/launcher";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { fakeRuntimes } from "./runtimeFixtures";
import { activeSessionIds, readSessionStateStore } from "../src/sessionStateStore";
import { cleanup, tempDir } from "./fixtures";

const api = vi.hoisted(() => ({ terminals: [], createTerminal: vi.fn() }));
vi.mock("vscode", () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
  window: api,
}));

let root: string;
let launcher: SessionLauncher;
let registry: TerminalRegistry;
let runtimes: ReturnType<typeof fakeRuntimes>;
let onSessionStarted: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
let processId: Promise<number | undefined>;
let coldCount: number;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await tempDir("pi-launcher-test-");
  processId = Promise.resolve(123);
  coldCount = 0;
  runtimes = fakeRuntimes();
  registry = new TerminalRegistry(runtimes.store, editorTerminals(runtimes.store), runtimes.mux);
  api.createTerminal.mockImplementation((creationOptions: vscode.TerminalOptions) => {
    const terminal = {
      creationOptions,
      processId,
      show: vi.fn(),
      dispose: vi.fn(() => registry.onTerminalClosed(terminal as unknown as vscode.Terminal)),
    };
    const args = creationOptions.shellArgs as string[];
    const cwd = (creationOptions.cwd as vscode.Uri).fsPath;
    if (args[0] === "new") {
      const existing = [...runtimes.live.values()].find((runtime) => runtime.cwd === cwd);
      runtimes.mocks.open({ sessionId: existing?.sessionId ?? `cold-${++coldCount}`, cwd });
    } else runtimes.mocks.open({ sessionId: args[1], cwd });
    return terminal;
  });
  onSessionStarted = vi.fn();
  launcher = new SessionLauncher({
    statePath: join(root, "session-state.json"),
    registry,
    onSessionStarted,
  });
});

afterEach(async () => {
  launcher.dispose();
  await cleanup(root);
});

function stateIds(): Set<string> {
  const store = readSessionStateStore(join(root, "session-state.json"));
  return store.status === "ok" ? activeSessionIds(store.data) : new Set();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type MockDisplay = Omit<vscode.Terminal, "show" | "dispose"> & {
  show: ReturnType<typeof vi.fn<(preserveFocus?: boolean) => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
};

async function existingDisplay(): Promise<MockDisplay> {
  runtimes.mocks.open({ sessionId: "old", cwd: root });
  return (await registry.open({ sessionId: "old", cwd: root })).terminal as MockDisplay;
}

describe("SessionLauncher", () => {
  it("creates and shows a cold native Terminal before its process ID or attachment resolves", async () => {
    const pid = deferred<number>();
    processId = pid.promise;
    const launching = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    const terminal = api.createTerminal.mock.results[0].value;
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(api.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: root },
        location: 1,
        shellPath: "pi-mux",
        shellArgs: ["new"],
      }),
    );
    expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
    expect(runtimes.mocks.list).not.toHaveBeenCalled();
    expect(stateIds()).toEqual(new Set());
    expect(registry.displayedSessionId).toBeUndefined();
    pid.resolve(123);
    await launching;
    expect(stateIds()).toEqual(new Set(["cold-1"]));
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("cold-1");
    expect(registry.displayedSessionId).toBe("cold-1");
  });

  it("resolves a cold session from the attached client's target without a detached new or list", async () => {
    runtimes.mocks.list.mockImplementation(() => {
      throw new Error("must not wait for list");
    });
    await launcher.start(root);
    expect(runtimes.mocks.resolveSession).toHaveBeenCalledWith("pi-cold-1");
    expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
    expect(stateIds()).toEqual(new Set(["cold-1"]));
  });

  it.each(["newSession", "list", "clients"] as const)(
    "shows an existing Terminal before unresolved %s and registers only after attachment",
    async (method) => {
      const terminal = await existingDisplay();
      const gate = deferred<never>();
      runtimes.mocks[method].mockReturnValueOnce(gate.promise);
      const launching = launcher.start(root).catch((error: Error) => error);
      await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledOnce());
      expect(registry.displayedSessionId).toBe("old");
      expect(stateIds()).toEqual(new Set());
      gate.reject(new Error("gate released"));
      expect(await launching).toBeInstanceOf(Error);
      expect(registry.displayedSessionId).toBe("old");
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(onSessionStarted).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "shows a second click while the previous attach is pending (other cwd=%s)",
    async (otherCwd) => {
      const nextCwd = otherCwd ? join(root, "other") : root;
      if (otherCwd) await mkdir(nextCwd);
      const gate = deferred<Awaited<ReturnType<typeof runtimes.store.clients>>>();
      runtimes.mocks.clients.mockReturnValueOnce(gate.promise);
      const first = launcher.start(root);
      await vi.waitFor(() => expect(runtimes.mocks.clients).toHaveBeenCalledOnce());
      const terminal = api.createTerminal.mock.results[0].value;
      const second = launcher.start(nextCwd);
      await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledTimes(2));
      expect(api.createTerminal).toHaveBeenCalledOnce();
      expect(stateIds()).toEqual(new Set());
      expect(registry.displayedSessionId).toBeUndefined();
      gate.resolve([runtimes.client]);
      await Promise.all([first, second]);
      expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["cold-1", "new-1"]);
      expect(registry.displayedSessionId).toBe("new-1");
      expect(api.createTerminal).toHaveBeenCalledTimes(otherCwd ? 2 : 1);
    },
  );

  it("creates a second click's Terminal while a closed first display still has an unresolved process ID", async () => {
    const pid = deferred<number>();
    processId = pid.promise;
    const first = launcher.start(root).catch((error: Error) => error);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    const old = api.createTerminal.mock.results[0].value;
    registry.onTerminalClosed(old);
    const secondPid = deferred<number>();
    processId = secondPid.promise;
    const second = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledTimes(2));
    expect(api.createTerminal.mock.results[1].value.show).toHaveBeenCalledOnce();
    secondPid.resolve(123);
    await second;
    expect(await first).toBeInstanceOf(Error);
    expect(registry.displayedSessionId).toBe("cold-1");
    pid.resolve(123);
  });

  it("creates a second click's Terminal before a queued predecessor's new call resolves", async () => {
    const terminal = await existingDisplay();
    const pending = deferred<string>();
    runtimes.mocks.newSession.mockReturnValueOnce(pending.promise);
    const first = launcher.start(root);
    await vi.waitFor(() => expect(runtimes.mocks.newSession).toHaveBeenCalledOnce());
    registry.onTerminalClosed(terminal);
    const second = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledTimes(2));
    expect(api.createTerminal.mock.results[1].value.show).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBe("old");
    pending.resolve("old");
    await Promise.all([first, second]);
  });

  it("waits only for shared close completion and never creates two live display tabs", async () => {
    const terminal = await existingDisplay();
    vi.mocked(terminal.dispose).mockImplementation(() => {});
    const other = join(root, "other");
    await mkdir(other);
    const first = launcher.start(other);
    await vi.waitFor(() => expect(terminal.dispose).toHaveBeenCalledOnce());
    const second = launcher.start(root);
    await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledOnce());
    expect(api.createTerminal).toHaveBeenCalledOnce();
    registry.onTerminalClosed(terminal);
    await Promise.all([first, second]);
    expect(api.createTerminal).toHaveBeenCalledTimes(3);
    expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["new-1", "new-2"]);
  });

  it("shows another click immediately while an earlier switch-client is unresolved", async () => {
    const terminal = await existingDisplay();
    const switching = deferred<void>();
    runtimes.mocks.switchClient.mockReturnValueOnce(switching.promise);
    const first = launcher.start(root);
    await vi.waitFor(() => expect(runtimes.mocks.switchClient).toHaveBeenCalledOnce());
    const second = launcher.start(root);
    await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledTimes(2));
    expect(registry.displayedSessionId).toBe("old");
    expect(stateIds()).toEqual(new Set());
    switching.resolve();
    await Promise.all([first, second]);
    expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["new-1", "new-2"]);
  });

  it("preserves the old display and membership when switch-client fails", async () => {
    const terminal = await existingDisplay();
    runtimes.mocks.switchClient.mockRejectedValueOnce(new Error("switch failed"));
    await expect(launcher.start(root)).rejects.toThrow("switch failed");
    expect(registry.displayedSessionId).toBe("old");
    expect(runtimes.client.target).toBe("pi-old");
    expect(stateIds()).toEqual(new Set());
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(runtimes.mocks.closeSession).not.toHaveBeenCalled();
  });

  it("reasserts Terminal focus after cold attachment without delaying its first show", async () => {
    const pid = deferred<number>();
    processId = pid.promise;
    const launching = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    const terminal = api.createTerminal.mock.results[0].value;
    expect(terminal.show).toHaveBeenCalledOnce();
    pid.resolve(123);
    await launching;
    expect(terminal.show).toHaveBeenCalledTimes(2);
  });

  it("normalizes cwd before creating the cold Terminal", async () => {
    await launcher.start(`${root}/.`);
    expect(api.createTerminal.mock.calls[0][0].cwd.fsPath).toBe(root);
  });

  it.each(["relative/path", "/definitely-missing-pi-launcher-directory"])(
    "rejects invalid cwd without changing Terminal, state or Pi: %s",
    async (cwd) => {
      await expect(launcher.start(cwd)).rejects.toThrow();
      expect(api.createTerminal).not.toHaveBeenCalled();
      expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
      expect(stateIds()).toEqual(new Set());
    },
  );

  it("rejects a file as cwd", async () => {
    const file = join(root, "file");
    await writeFile(file, "fixture");
    await expect(launcher.start(file)).rejects.toThrow();
    expect(api.createTerminal).not.toHaveBeenCalled();
  });

  it("uses the CLI's same-cwd empty session on repeated clicks", async () => {
    await launcher.start(root);
    runtimes.mocks.newSession.mockResolvedValue("cold-1");
    await launcher.start(root);
    await launcher.start(root);
    expect(api.createTerminal).toHaveBeenCalledOnce();
    expect(runtimes.live.size).toBe(1);
    expect(stateIds()).toEqual(new Set(["cold-1"]));
    expect(runtimes.mocks.switchClient).not.toHaveBeenCalled();
  });

  it("closes a failed cold Terminal without registering, refreshing, or killing Pi", async () => {
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("attachment failed"));
    await expect(launcher.start(root)).rejects.toThrow("attachment failed");
    expect(api.createTerminal.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(stateIds()).toEqual(new Set());
    expect(onSessionStarted).not.toHaveBeenCalled();
    expect(runtimes.mocks.closeSession).not.toHaveBeenCalled();
    expect(runtimes.live.size).toBe(1);
  });

  it("connects a logical symlink cwd to its physical metadata without changing registration keys", async () => {
    const alias = join(root, "alias");
    await symlink(root, alias);
    runtimes.mocks.resolveSession.mockResolvedValueOnce({
      sessionId: "cold-1",
      cwd: root,
      file: join(root, "cold-1.jsonl"),
      target: "pi-cold-1",
    });
    await launcher.start(alias);
    expect(api.createTerminal.mock.calls[0][0].cwd.fsPath).toBe(alias);
    expect(api.createTerminal.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("cold-1");
    expect(stateIds()).toEqual(new Set(["cold-1"]));
    const store = readSessionStateStore(join(root, "session-state.json"));
    expect(store.status === "ok" && Object.keys(store.data["active-workspaces"])).toEqual([alias]);
  });

  it("rejects a cold metadata cwd mismatch without publishing selection", async () => {
    const other = join(root, "other");
    await mkdir(other);
    runtimes.mocks.resolveSession.mockResolvedValueOnce({
      sessionId: "wrong",
      cwd: other,
      file: "/wrong.jsonl",
      target: "pi-wrong",
    });
    await expect(launcher.start(root)).rejects.toThrow("cwd mismatch");
    expect(stateIds()).toEqual(new Set());
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("preserves invalid state data when registration fails after connection", async () => {
    const path = join(root, "session-state.json");
    await writeFile(path, "{ invalid");
    await expect(launcher.start(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ invalid");
    expect(onSessionStarted).not.toHaveBeenCalled();
    expect(runtimes.live.size).toBe(1);
  });

  it("does not create a Terminal after disposal", async () => {
    launcher.dispose();
    await launcher.start(root);
    expect(api.createTerminal).not.toHaveBeenCalled();
  });
});
