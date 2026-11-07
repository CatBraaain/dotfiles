import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import type { PiRuntime } from "../src/tmux";
import { fakeRuntimes } from "./runtimeFixtures";

const windowMock = vi.hoisted(() => ({
  terminals: [] as vscode.Terminal[],
  createTerminal: vi.fn(),
}));
vi.mock("vscode", () => ({
  window: windowMock,
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
}));

function displayTerminal(cwd = "/project"): vscode.Terminal {
  return {
    creationOptions: { cwd },
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(),
  } as unknown as vscode.Terminal;
}

function setup(restored?: vscode.Terminal, cwd = "/project") {
  const runtimes = fakeRuntimes();
  const terminal = displayTerminal(cwd);
  const displays = {
    create: vi
      .fn((runtime: PiRuntime) => {
        const replacement = displayTerminal(runtime.cwd);
        closeAutomatically(replacement);
        return replacement;
      })
      .mockReturnValueOnce(terminal),
    find: vi.fn(() => (restored?.exitStatus === undefined ? restored : undefined)),
  };
  const registry = new TerminalRegistry(runtimes.store, displays);
  closeAutomatically(terminal);
  if (restored !== undefined) closeAutomatically(restored);

  function closeAutomatically(display: vscode.Terminal): void {
    vi.mocked(display.dispose).mockImplementation(() => {
      queueMicrotask(() => {
        Object.defineProperty(display, "exitStatus", { value: { code: 0 }, configurable: true });
        registry.onTerminalClosed(display);
      });
    });
  }

  return { ...runtimes, terminal, displays, registry };
}

function launch(sessionId: string, cwd = "/project") {
  return { sessionId, cwd, args: ["--session", `/sessions/${sessionId}.jsonl`] };
}

describe("TerminalRegistry", () => {
  it("keeps same-cwd A and B runtimes and switches only its shared display client in arrival order", async () => {
    const { registry, mocks, live, displays } = setup();
    await Promise.all(
      ["A", "B", "A", "B"].map((id) => registry.run(() => registry.open(launch(id)))),
    );
    expect([...live.keys()]).toEqual(["A", "B"]);
    expect(displays.create).toHaveBeenCalledTimes(1);
    expect(mocks.switchClient.mock.calls.map(([, runtime]) => runtime.sessionId)).toEqual([
      "A",
      "B",
      "A",
      "B",
    ]);
    expect(mocks.switchClient.mock.calls.every(([client]) => client.pid === 123)).toBe(true);
  });

  it("recreates the display in each selected cwd while preserving both Pi runtimes", async () => {
    const { registry, live, displays } = setup();
    const runtimes = new Map<string, PiRuntime>();
    for (const id of ["A", "B", "A", "B"]) {
      const result = await registry.run(() =>
        registry.open(launch(id, id === "A" ? "/project" : "/worktree")),
      );
      if (runtimes.has(id)) expect(result.runtime).toBe(runtimes.get(id));
      else runtimes.set(id, result.runtime);
    }
    expect(displays.create.mock.calls.map(([runtime]) => runtime.cwd)).toEqual([
      "/project",
      "/worktree",
      "/project",
      "/worktree",
    ]);
    expect([...live.values()]).toEqual([...runtimes.values()]);
  });

  it("waits for a slow close event before creating another cwd display or processing the next selection", async () => {
    const { registry, terminal, displays, mocks } = setup();
    await registry.run(() => registry.open(launch("A")));
    vi.mocked(terminal.dispose).mockImplementation(() => {});
    const toB = registry.run(() => registry.open(launch("B", "/worktree")));
    const backToA = registry.run(() => registry.open(launch("A")));

    await vi.waitFor(() => expect(terminal.dispose).toHaveBeenCalledTimes(1));
    expect(displays.create).toHaveBeenCalledTimes(1);
    expect(mocks.ensure.mock.calls.map(([request]) => request.sessionId)).toEqual(["A", "B"]);
    registry.onTerminalClosed(displayTerminal());
    expect(displays.create).toHaveBeenCalledTimes(1);

    registry.onTerminalClosed(terminal);
    const selectedB = await toB;
    const selectedA = await backToA;
    expect(selectedB.terminal).not.toBe(terminal);
    expect(selectedA.terminal).not.toBe(selectedB.terminal);
    expect(displays.create).toHaveBeenCalledTimes(3);
  });

  it("recreates only the display after closing the terminal", async () => {
    const { registry, live, terminal, displays } = setup();
    await registry.open(launch("A"));
    const runtime = live.get("A");
    registry.onTerminalClosed(terminal);
    await registry.open(launch("A"));
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("tracks the displayed session and clears it when the display terminal closes", async () => {
    const { registry, terminal } = setup();
    expect(registry.displayedSessionId).toBeUndefined();

    await registry.open(launch("A"));
    expect(registry.displayedSessionId).toBe("A");

    await registry.open(launch("B"));
    expect(registry.displayedSessionId).toBe("B");

    registry.onTerminalClosed(terminal);
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("replaces an exited display without restarting its live Pi", async () => {
    const { registry, terminal, displays, live } = setup();
    await registry.open(launch("A"));
    const runtime = live.get("A");
    Object.defineProperty(terminal, "exitStatus", {
      value: { code: 0, reason: 1 },
      configurable: true,
    });
    const replacement = displayTerminal();
    displays.create.mockReturnValueOnce(replacement);

    const result = await registry.open(launch("A"));

    expect(result.terminal).toBe(replacement);
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("rediscovers an owned same-cwd display after extension host restart", async () => {
    const existing = displayTerminal();
    const { registry, displays } = setup(existing);
    const result = await registry.open(launch("A"));
    expect(result.terminal).toBe(existing);
    expect(displays.create).not.toHaveBeenCalled();
  });

  it("replaces a legacy fixed Pi display in the same cwd only after it closes", async () => {
    const existing = displayTerminal();
    Object.defineProperties(existing, {
      creationOptions: { value: { name: "Pi", cwd: { fsPath: "/project" } } },
      name: { value: "Pi" },
    });
    const { registry, displays, terminal, live, store } = setup(existing);
    const runtime = await store.ensure(launch("A"));
    vi.mocked(existing.dispose).mockImplementation(() => {});
    const opening = registry.run(() => registry.open(launch("A")));

    await vi.waitFor(() => expect(existing.dispose).toHaveBeenCalledTimes(1));
    expect(displays.create).not.toHaveBeenCalled();
    registry.onTerminalClosed(existing);

    const result = await opening;
    expect(result.terminal).toBe(terminal);
    expect(result.runtime).toBe(runtime);
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { creationName: undefined, currentName: "Pi" },
    { creationName: "Pi", currentName: "My terminal" },
    { creationName: "My terminal", currentName: "My terminal" },
  ])(
    "preserves a custom terminal title without treating it as the legacy fixed name: %j",
    async ({ creationName, currentName }) => {
      const existing = displayTerminal();
      Object.defineProperties(existing, {
        creationOptions: { value: { name: creationName, cwd: "/project" } },
        name: { value: currentName },
      });
      const { registry, displays } = setup(existing);

      const result = await registry.open(launch("A"));

      expect(result.terminal).toBe(existing);
      expect(existing.dispose).not.toHaveBeenCalled();
      expect(displays.create).not.toHaveBeenCalled();
    },
  );

  it("replaces a rediscovered display from another cwd after extension host restart", async () => {
    const existing = displayTerminal("/old-project");
    const { registry, displays, terminal } = setup(existing);
    const result = await registry.open(launch("A"));
    expect(existing.dispose).toHaveBeenCalledTimes(1);
    expect(result.terminal).toBe(terminal);
    expect(displays.create).toHaveBeenCalledTimes(1);
  });

  it("does not clear the shared display when an unrelated terminal closes", async () => {
    const { registry, displays } = setup();
    await registry.open(launch("A"));
    registry.onTerminalClosed(displayTerminal());
    await registry.open(launch("B"));
    expect(displays.create).toHaveBeenCalledTimes(1);
  });

  it("does not create a display when tmux fails and permits a later retry", async () => {
    const { registry, mocks, displays } = setup();
    mocks.ensure.mockRejectedValueOnce(new Error("tmux missing"));
    await expect(registry.run(() => registry.open(launch("A")))).rejects.toThrow("tmux missing");
    expect(displays.create).not.toHaveBeenCalled();
    await registry.run(() => registry.open(launch("A")));
    expect(displays.create).toHaveBeenCalledTimes(1);
  });

  it("retains the runtime but removes a failed new display connection", async () => {
    const { registry, mocks, terminal, live } = setup();
    mocks.clients.mockRejectedValueOnce(new Error("client failed"));
    await expect(registry.open(launch("A"))).rejects.toThrow("client failed");
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(live.has("A")).toBe(true);
  });

  it("does not wait for another close event when the display closed during attachment", async () => {
    const { registry, mocks, terminal, displays, live } = setup();
    vi.mocked(terminal.dispose).mockImplementation(() => {});
    mocks.clients.mockImplementationOnce(async () => {
      registry.onTerminalClosed(terminal);
      throw new Error("closed during attachment");
    });

    await expect(registry.run(() => registry.open(launch("A")))).rejects.toThrow(
      "closed during attachment",
    );
    expect(terminal.dispose).not.toHaveBeenCalled();
    const runtime = live.get("A");
    await registry.run(() => registry.open(launch("A")));
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("waits for a failed display to close before allowing a queued retry", async () => {
    const { registry, mocks, terminal, displays } = setup();
    mocks.clients.mockRejectedValueOnce(new Error("client failed"));
    vi.mocked(terminal.dispose).mockImplementation(() => {});
    const failed = registry.run(() => registry.open(launch("A")));
    const rejection = expect(failed).rejects.toThrow("client failed");
    const retry = registry.run(() => registry.open(launch("A")));

    await vi.waitFor(() => expect(terminal.dispose).toHaveBeenCalledTimes(1));
    expect(displays.create).toHaveBeenCalledTimes(1);
    registry.onTerminalClosed(terminal);
    await rejection;
    await retry;
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("serializes a new runtime and saved-session selection through the same queue", async () => {
    const { registry, mocks, displays } = setup(undefined, "/other");
    await Promise.all([
      registry.run(() =>
        registry.open({ sessionId: "new", cwd: "/other", args: ["--session-id", "new"] }),
      ),
      registry.run(() => registry.open(launch("A"))),
    ]);
    expect(mocks.ensure.mock.calls.map(([request]) => request.sessionId)).toEqual(["new", "A"]);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });
});

describe("editorTerminals", () => {
  it("recognizes ownership instead of adopting an unrelated terminal named Pi", () => {
    const { store } = fakeRuntimes();
    const unrelated = { name: "Pi", creationOptions: { name: "Pi" } } as vscode.Terminal;
    const owned = {
      name: "tmux",
      creationOptions: { env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketName } },
    } as unknown as vscode.Terminal;
    windowMock.terminals = [unrelated, owned];
    expect(editorTerminals(store).find()).toBe(owned);
    windowMock.terminals = [unrelated];
    expect(editorTerminals(store).find()).toBeUndefined();
  });

  it("creates a native-title editor terminal attached without detaching other clients", () => {
    const { store } = fakeRuntimes();
    windowMock.createTerminal.mockClear();
    editorTerminals(store).create({ sessionId: "A", cwd: "/project", target: "pi-A" });
    expect(windowMock.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: { fsPath: "/project" },
        location: 1,
        shellPath: "tmux",
        shellArgs: ["-L", "fixture-socket", "-f", "/dev/null", "attach-session", "-t", "pi-A"],
        env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketName, TMUX: null, TMUX_PANE: null },
      }),
    );
    expect(windowMock.createTerminal.mock.calls[0][0]).not.toHaveProperty("name");
  });
});
