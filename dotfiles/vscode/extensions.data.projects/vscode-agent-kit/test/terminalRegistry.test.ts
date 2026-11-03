import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
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

function displayTerminal(): vscode.Terminal {
  return {
    processId: Promise.resolve(123),
    show: vi.fn(),
    dispose: vi.fn(),
  } as unknown as vscode.Terminal;
}

function setup(restored?: vscode.Terminal) {
  const runtimes = fakeRuntimes();
  const terminal = displayTerminal();
  const displays = { create: vi.fn(() => terminal), find: vi.fn(() => restored) };
  return {
    ...runtimes,
    terminal,
    displays,
    registry: new TerminalRegistry(runtimes.store, displays),
  };
}

function launch(sessionId: string) {
  return { sessionId, cwd: "/project", args: ["--session", `/sessions/${sessionId}.jsonl`] };
}

describe("TerminalRegistry", () => {
  it("keeps A and B runtimes and switches only its shared display client in arrival order", async () => {
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

  it("recreates only the display after closing the terminal", async () => {
    const { registry, live, terminal, displays } = setup();
    await registry.open(launch("A"));
    const runtime = live.get("A");
    registry.onTerminalClosed(terminal);
    await registry.open(launch("A"));
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("replaces an exited display without restarting its live Pi", async () => {
    const { registry, terminal, displays, live } = setup();
    await registry.open(launch("A"));
    const runtime = live.get("A");
    Object.defineProperty(terminal, "exitStatus", { value: { code: 0, reason: 1 } });
    const replacement = displayTerminal();
    displays.create.mockReturnValueOnce(replacement);

    const result = await registry.open(launch("A"));

    expect(result.terminal).toBe(replacement);
    expect(live.get("A")).toBe(runtime);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("rediscovers an owned display after extension host restart", async () => {
    const existing = displayTerminal();
    const { registry, displays } = setup(existing);
    const result = await registry.open(launch("A"));
    expect(result.terminal).toBe(existing);
    expect(displays.create).not.toHaveBeenCalled();
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

  it("serializes a new runtime and saved-session selection through the same queue", async () => {
    const { registry, mocks, displays } = setup();
    await Promise.all([
      registry.run(() =>
        registry.open({ sessionId: "new", cwd: "/other", args: ["--session-id", "new"] }),
      ),
      registry.run(() => registry.open(launch("A"))),
    ]);
    expect(mocks.ensure.mock.calls.map(([request]) => request.sessionId)).toEqual(["new", "A"]);
    expect(displays.create).toHaveBeenCalledTimes(1);
  });
});

describe("editorTerminals", () => {
  it("recognizes ownership instead of adopting an unrelated terminal named Pi", () => {
    const { store } = fakeRuntimes();
    const unrelated = { name: "Pi", creationOptions: { name: "Pi" } } as vscode.Terminal;
    const owned = {
      name: "Pi",
      creationOptions: { env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketName } },
    } as unknown as vscode.Terminal;
    windowMock.terminals = [unrelated, owned];
    expect(editorTerminals(store).find()).toBe(owned);
    windowMock.terminals = [unrelated];
    expect(editorTerminals(store).find()).toBeUndefined();
  });

  it("creates a standard editor terminal attached without detaching other clients", () => {
    const { store } = fakeRuntimes();
    editorTerminals(store).create({ sessionId: "A", cwd: "/project", target: "pi-A" });
    expect(windowMock.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Pi",
        location: 1,
        shellPath: "tmux",
        shellArgs: ["-L", "fixture-socket", "-f", "/dev/null", "attach-session", "-t", "pi-A"],
        env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketName, TMUX: null, TMUX_PANE: null },
      }),
    );
  });
});
