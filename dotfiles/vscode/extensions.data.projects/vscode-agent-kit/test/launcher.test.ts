import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import type * as vscode from "vscode";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionLauncher } from "../src/launcher";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import { fakeRuntimes } from "./runtimeFixtures";
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

beforeEach(async () => {
  vi.clearAllMocks();
  root = await tempDir("pi-launcher-test-");
  processId = Promise.resolve(123);
  runtimes = fakeRuntimes();
  registry = new TerminalRegistry(editorTerminals(), runtimes.mux);
  api.createTerminal.mockImplementation((creationOptions: vscode.TerminalOptions) => {
    const terminal = {
      creationOptions,
      processId,
      show: vi.fn(),
      dispose: vi.fn(() => registry.onTerminalClosed(terminal as unknown as vscode.Terminal)),
    };
    const args = creationOptions.shellArgs as string[];
    runtimes.mocks.open({
      sessionId: args[1],
      cwd: runtimes.live.get(args[1])?.cwd ?? root,
    });
    return terminal;
  });
  onSessionStarted = vi.fn();
  launcher = new SessionLauncher({
    registry,
    onSessionStarted,
  });
});

afterEach(async () => {
  launcher.dispose();
  await cleanup(root);
});

function startedIds(): Set<string> {
  return new Set(onSessionStarted.mock.calls.map(([id]) => id));
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
  it("returns the actual previous display after earlier queued selections finish", async () => {
    await existingDisplay();
    runtimes.mocks.open({ sessionId: "queued", cwd: root });
    const selected = registry.run(() => registry.open({ sessionId: "queued", cwd: root }));
    const launched = launcher.start(root);
    await selected;
    expect(await launched).toBe("queued");
    expect(registry.displayedSessionId).not.toBe("queued");
  });

  it("creates and shows the display Terminal without waiting for its process ID", async () => {
    const pid = deferred<number>();
    processId = pid.promise;
    const launching = launcher.start(root);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    const terminal = api.createTerminal.mock.results[0].value;
    await launching;
    expect(api.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: homedir() },
        location: 1,
        shellPath: "pi-mux",
        shellArgs: ["open", "new-1"],
      }),
    );
    expect(runtimes.mocks.current).not.toHaveBeenCalled();
    pid.resolve(123);
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(startedIds()).toEqual(new Set(["new-1"]));
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("new-1");
    expect(registry.displayedSessionId).toBe("new-1");
  });

  it("signals presentation after show without waiting for the process ID or session refresh", async () => {
    const pid = deferred<number>();
    const refreshed = deferred<void>();
    processId = pid.promise;
    onSessionStarted.mockImplementationOnce(() => refreshed.promise);
    const onPresented = vi.fn();
    const launching = launcher.start(root, onPresented);
    await vi.waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
    const terminal = api.createTerminal.mock.results[0].value;
    await vi.waitFor(() => expect(onSessionStarted).toHaveBeenCalledOnce());
    expect(runtimes.mocks.current).not.toHaveBeenCalled();
    pid.resolve(123);
    expect(onPresented).toHaveBeenCalledOnce();
    expect(terminal.show.mock.invocationCallOrder[0]).toBeLessThan(
      onPresented.mock.invocationCallOrder[0],
    );
    expect(onPresented.mock.invocationCallOrder[0]).toBeLessThan(
      onSessionStarted.mock.invocationCallOrder[0],
    );
    refreshed.resolve();
    await launching;
  });

  it.each(["newSession", "list"] as const)(
    "does not signal presentation when %s fails",
    async (method) => {
      runtimes.mocks[method].mockRejectedValueOnce(new Error("launch failed"));
      const onPresented = vi.fn();
      await expect(launcher.start(root, onPresented)).rejects.toThrow("launch failed");
      expect(onPresented).not.toHaveBeenCalled();
    },
  );

  it("reserves the empty Pi through a detached new without opening it twice", async () => {
    await launcher.start(root);
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(root);
    expect(api.createTerminal.mock.calls[0][0].shellArgs).toEqual(["open", "new-1"]);
    expect(startedIds()).toEqual(new Set(["new-1"]));
  });

  it.each(["newSession", "list", "current"] as const)(
    "shows an existing Terminal before unresolved %s and refreshes only after attachment",
    async (method) => {
      const terminal = await existingDisplay();
      const gate = deferred<never>();
      void gate.promise.catch(() => {});
      runtimes.mocks[method].mockReturnValueOnce(gate.promise);
      const launching = launcher.start(root).catch((error: Error) => error);
      await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledOnce());
      expect(registry.displayedSessionId).toBe("old");
      expect(startedIds()).toEqual(new Set());
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
      const terminal = await existingDisplay();
      const gate = deferred<Awaited<ReturnType<typeof runtimes.mux.current>>>();
      runtimes.mocks.current.mockReturnValueOnce(gate.promise);
      const first = launcher.start(root);
      await vi.waitFor(() => expect(runtimes.mocks.current).toHaveBeenCalledOnce());
      const second = launcher.start(nextCwd);
      await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledTimes(2));
      expect(api.createTerminal).toHaveBeenCalledOnce();
      expect(startedIds()).toEqual(new Set());
      expect(registry.displayedSessionId).toBe("old");
      gate.resolve(undefined);
      await Promise.all([first, second]);
      expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["new-1", "new-2"]);
      expect(registry.displayedSessionId).toBe("new-2");
      expect(api.createTerminal).toHaveBeenCalledOnce();
      expect(terminal.show).toHaveBeenCalledTimes(4);
    },
  );

  it("creates a second click's Terminal without waiting for a closed display's process ID", async () => {
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
    await second;
    secondPid.resolve(123);
    expect(api.createTerminal.mock.results[1].value.show).toHaveBeenCalledOnce();
    expect(await first).toBeUndefined();
    expect(registry.displayedSessionId).toBe("new-2");
    pid.resolve(123);
  });

  it("reuses the shared display across cwds without creating extra display tabs", async () => {
    const terminal = await existingDisplay();
    const other = join(root, "other");
    await mkdir(other);
    await launcher.start(other);
    await launcher.start(root);
    expect(api.createTerminal).toHaveBeenCalledOnce();
    expect(runtimes.mocks.switch.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "new-1",
      "new-2",
    ]);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["new-1", "new-2"]);
  });

  it("shows another click immediately while an earlier switch is unresolved", async () => {
    const terminal = await existingDisplay();
    const switching = deferred<boolean>();
    runtimes.mocks.switch.mockReturnValueOnce(switching.promise);
    const first = launcher.start(root);
    await vi.waitFor(() => expect(runtimes.mocks.switch).toHaveBeenCalledOnce());
    const second = launcher.start(root);
    await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledTimes(2));
    expect(registry.displayedSessionId).toBe("old");
    expect(startedIds()).toEqual(new Set());
    switching.resolve(true);
    await Promise.all([first, second]);
    expect(onSessionStarted.mock.calls.map(([id]) => id)).toEqual(["new-1", "new-2"]);
  });

  it("preserves the old display and membership when switch fails", async () => {
    const terminal = await existingDisplay();
    runtimes.mocks.switch.mockRejectedValueOnce(new Error("switch failed"));
    await expect(launcher.start(root)).rejects.toThrow("switch failed");
    expect(registry.displayedSessionId).toBe("old");
    expect(runtimes.client.attachedId).toBe("old");
    expect(startedIds()).toEqual(new Set());
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(runtimes.mocks.closeSession).not.toHaveBeenCalled();
  });

  it("normalizes cwd before reserving the empty session", async () => {
    await launcher.start(`${root}/.`);
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(root);
    expect(startedIds()).toEqual(new Set(["new-1"]));
  });

  it.each(["relative/path", "/definitely-missing-pi-launcher-directory"])(
    "rejects invalid cwd without changing Terminal, state or Pi: %s",
    async (cwd) => {
      await expect(launcher.start(cwd)).rejects.toThrow();
      expect(api.createTerminal).not.toHaveBeenCalled();
      expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
      expect(startedIds()).toEqual(new Set());
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
    runtimes.mocks.newSession.mockResolvedValue("new-1");
    await launcher.start(root);
    await launcher.start(root);
    expect(api.createTerminal).toHaveBeenCalledOnce();
    expect(runtimes.live.size).toBe(1);
    expect(startedIds()).toEqual(new Set(["new-1"]));
    expect(runtimes.mocks.switch).not.toHaveBeenCalled();
  });

  it("reports Terminal creation failure without refreshing or killing Pi", async () => {
    api.createTerminal.mockImplementationOnce(() => {
      throw new Error("Terminal creation failed");
    });
    await expect(launcher.start(root)).rejects.toThrow("Terminal creation failed");
    expect(startedIds()).toEqual(new Set());
    expect(onSessionStarted).not.toHaveBeenCalled();
    expect(runtimes.mocks.closeSession).not.toHaveBeenCalled();
    expect(runtimes.live.size).toBe(1);
  });

  it("connects a logical symlink cwd without changing registration keys", async () => {
    const alias = join(root, "alias");
    await symlink(root, alias);
    await launcher.start(alias);
    expect(api.createTerminal.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("new-1");
    expect(startedIds()).toEqual(new Set(["new-1"]));
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(alias);
  });

  it("starts and refreshes without reading or writing invalid legacy JSON", async () => {
    const path = join(root, "session-state.json");
    await writeFile(path, "{ invalid");
    await launcher.start(root);
    expect(await readFile(path, "utf8")).toBe("{ invalid");
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("new-1");
    expect(runtimes.live.size).toBe(1);
  });

  it("does not create a Terminal after disposal", async () => {
    launcher.dispose();
    await launcher.start(root);
    expect(api.createTerminal).not.toHaveBeenCalled();
  });
});
