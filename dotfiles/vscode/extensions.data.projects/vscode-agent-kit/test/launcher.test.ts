import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

beforeEach(async () => {
  vi.clearAllMocks();
  root = await tempDir("pi-launcher-test-");
  runtimes = fakeRuntimes();
  registry = new TerminalRegistry(runtimes.store, editorTerminals(runtimes.store), runtimes.mux);
  api.createTerminal.mockImplementation((creationOptions: vscode.TerminalOptions) => {
    const terminal = {
      creationOptions,
      processId: Promise.resolve(123),
      show: vi.fn(),
      dispose: vi.fn(() => registry.onTerminalClosed(terminal as unknown as vscode.Terminal)),
    };
    const args = creationOptions.shellArgs as string[];
    runtimes.mocks.open({ sessionId: args[1], cwd: (creationOptions.cwd as vscode.Uri).fsPath });
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

function activeIds(): Set<string> {
  const store = readSessionStateStore(join(root, "session-state.json"));
  if (store.status !== "ok") throw new Error(`Expected state store, got ${store.status}`);
  return activeSessionIds(store.data);
}

describe("SessionLauncher", () => {
  it("asks pi-mux for a new ID in the selected cwd and opens that ID in the editor", async () => {
    const cwd = join(root, "selected");
    await mkdir(cwd);
    await launcher.start(cwd);
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(cwd);
    expect(api.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: cwd },
        location: 1,
        shellPath: "pi-mux",
        shellArgs: ["open", "new-1"],
      }),
    );
    expect(api.createTerminal.mock.results[0].value.show).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBe("new-1");
  });

  it("registers the returned ID before connecting without waiting for a session file", async () => {
    const originalList = runtimes.mocks.list.getMockImplementation()!;
    runtimes.mocks.list.mockImplementation(async () => {
      expect(activeIds()).toEqual(new Set(["new-1"]));
      return originalList();
    });
    await launcher.start(root);
    expect(activeIds()).toEqual(new Set(["new-1"]));
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("new-1");
  });

  it("normalizes the requested cwd before invoking pi-mux", async () => {
    await launcher.start(`${root}/.`);
    expect(runtimes.mocks.newSession).toHaveBeenCalledExactlyOnceWith(root);
  });

  it.each(["relative/path", "/definitely-missing-pi-launcher-directory"])(
    "rejects invalid cwd before any CLI call or Terminal creation: %s",
    async (cwd) => {
      await expect(launcher.start(cwd)).rejects.toThrow();
      expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
      expect(api.createTerminal).not.toHaveBeenCalled();
    },
  );

  it("rejects a file as cwd without starting Pi", async () => {
    const file = join(root, "file");
    await writeFile(file, "fixture");
    await expect(launcher.start(file)).rejects.toThrow();
    expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
  });

  it("delegates empty same-cwd conversation reuse to pi-mux on every request", async () => {
    runtimes.mocks.newSession.mockImplementation(async (cwd) => {
      runtimes.mocks.open({ sessionId: "empty", cwd });
      return "empty";
    });
    await launcher.start(root);
    await launcher.start(root);
    expect(runtimes.mocks.newSession.mock.calls).toEqual([[root], [root]]);
    expect(runtimes.live.size).toBe(1);
    expect(api.createTerminal).toHaveBeenCalledTimes(1);
    expect(activeIds()).toEqual(new Set(["empty"]));
    expect(onSessionStarted).toHaveBeenCalledTimes(2);
  });

  it("serializes new sessions across workspaces and registers each returned ID immediately", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await Promise.all([launcher.start(root), launcher.start(other)]);
    expect(runtimes.mocks.newSession.mock.calls).toEqual([[root], [other]]);
    expect(activeIds()).toEqual(new Set(["new-1", "new-2"]));
    expect(runtimes.live.size).toBe(2);
    expect(registry.displayedSessionId).toBe("new-2");
    expect(api.createTerminal).toHaveBeenCalledTimes(2);
  });

  it("preserves registration and refreshes when display connection fails", async () => {
    runtimes.mocks.clients.mockRejectedValueOnce(new Error("display connection failed"));
    await expect(launcher.start(root)).rejects.toThrow("display connection failed");
    expect(activeIds()).toEqual(new Set(["new-1"]));
    expect(onSessionStarted).toHaveBeenCalledExactlyOnceWith("new-1");
    expect(runtimes.live.size).toBe(1);
    expect(api.createTerminal.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });

  it("does not create a Terminal or change metadata when detached new fails", async () => {
    runtimes.mocks.newSession.mockRejectedValueOnce(new Error("pi-mux missing"));
    await expect(launcher.start(root)).rejects.toThrow("pi-mux missing");
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(onSessionStarted).not.toHaveBeenCalled();
    expect(readSessionStateStore(join(root, "session-state.json")).status).toBe("empty");
  });

  it("reports state registration failure without overwriting invalid metadata", async () => {
    const statePath = join(root, "session-state.json");
    await writeFile(statePath, "{ invalid");
    await expect(launcher.start(root)).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe("{ invalid");
    expect(api.createTerminal).not.toHaveBeenCalled();
    expect(runtimes.live.size).toBe(1);
  });

  it("does not start another Pi after disposal", async () => {
    launcher.dispose();
    await launcher.start(root);
    expect(runtimes.mocks.newSession).not.toHaveBeenCalled();
    expect(api.createTerminal).not.toHaveBeenCalled();
  });
});
