import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import type { PiSession } from "../src/piMux";
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

function session(sessionId: string, cwd = "/project"): PiSession {
  return { sessionId, cwd };
}

function setup(restored?: vscode.Terminal) {
  const runtimes = fakeRuntimes();
  for (const id of ["A", "B"]) runtimes.live.set(id, { ...session(id), target: `pi-${id}` });
  const displays = {
    create: vi.fn((request: PiSession) => {
      runtimes.mocks.open(request);
      const terminal = displayTerminal(request.cwd);
      closeAutomatically(terminal);
      return terminal;
    }),
    createNew: vi.fn((cwd: string) => {
      const terminal = displayTerminal(cwd);
      closeAutomatically(terminal);
      return terminal;
    }),
    find: vi.fn(() => restored),
  };
  const registry = new TerminalRegistry(runtimes.store, displays, runtimes.mux);
  if (restored !== undefined) closeAutomatically(restored);

  function closeAutomatically(terminal: vscode.Terminal): void {
    vi.mocked(terminal.dispose).mockImplementation(() => {
      queueMicrotask(() => {
        Object.defineProperty(terminal, "exitStatus", { value: { code: 0 }, configurable: true });
        registry.onTerminalClosed(terminal);
      });
    });
  }

  return { ...runtimes, displays, registry };
}

afterEach(() => vi.useRealTimers());

describe("TerminalRegistry", () => {
  it("switches live same-cwd conversations on one display in arrival order", async () => {
    const { registry, mocks, live, displays } = setup();
    const original = [...live.values()];
    await Promise.all(
      ["A", "B", "A", "B"].map((id) => registry.run(() => registry.open(session(id)))),
    );
    expect(displays.create).toHaveBeenCalledTimes(1);
    expect(mocks.switchClient.mock.calls.map(([, runtime]) => runtime.sessionId)).toEqual([
      "B",
      "A",
      "B",
    ]);
    expect(mocks.switchClient.mock.calls.every(([client]) => client.pid === 123)).toBe(true);
    expect([...live.values()]).toEqual(original);
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("B");
  });

  it("recreates the display for different cwd without restarting live Pi", async () => {
    const { registry, displays, live } = setup();
    const original = [...live.values()];
    for (const id of ["A", "B", "A", "B"]) {
      await registry.open(session(id, id === "A" ? "/project" : "/worktree"));
    }
    expect(displays.create.mock.calls.map(([request]) => request.cwd)).toEqual([
      "/project",
      "/worktree",
      "/project",
      "/worktree",
    ]);
    expect([...live.values()]).toEqual(original);
  });

  it("recreates even a same-cwd display when the selected Pi is not running", async () => {
    const { registry, displays, live, mocks } = setup();
    const first = await registry.open(session("A"));
    live.delete("B");
    const next = await registry.open(session("B"));
    expect(first.terminal.dispose).toHaveBeenCalledOnce();
    expect(next.terminal).not.toBe(first.terminal);
    expect(displays.create.mock.calls.map(([request]) => request.sessionId)).toEqual(["A", "B"]);
    expect(mocks.switchClient).not.toHaveBeenCalled();
    expect(live.has("B")).toBe(true);
    expect(live.has("A")).toBe(true);
  });

  it("waits for close completion before creating another display or handling a queued selection", async () => {
    const { registry, displays } = setup();
    const { terminal } = await registry.open(session("A"));
    vi.mocked(terminal.dispose).mockImplementation(() => {});
    const toB = registry.run(() => registry.open(session("B", "/worktree")));
    const toA = registry.run(() => registry.open(session("A")));
    await vi.waitFor(() => expect(terminal.dispose).toHaveBeenCalledOnce());
    expect(displays.create).toHaveBeenCalledTimes(1);
    registry.onTerminalClosed(displayTerminal());
    expect(displays.create).toHaveBeenCalledTimes(1);
    registry.onTerminalClosed(terminal);
    const b = await toB;
    const a = await toA;
    expect(b.terminal).not.toBe(terminal);
    expect(a.terminal).not.toBe(b.terminal);
    expect(displays.create).toHaveBeenCalledTimes(3);
  });

  it("keeps selection and live Pi when the tab closes and reconnects with a new display", async () => {
    const { registry, live, displays } = setup();
    const { terminal } = await registry.open(session("A"));
    const original = live.get("A");
    registry.onTerminalClosed(terminal);
    expect(registry.displayedSessionId).toBe("A");
    await registry.open(session("A"));
    expect(live.get("A")).toBe(original);
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("does not clear the display when an unrelated Terminal closes", async () => {
    const { registry, displays } = setup();
    await registry.open(session("A"));
    registry.onTerminalClosed(displayTerminal());
    await registry.open(session("B"));
    expect(displays.create).toHaveBeenCalledTimes(1);
  });

  it("rediscovers an owned same-cwd Terminal after extension host restart", async () => {
    const existing = displayTerminal();
    const { registry, displays, client } = setup(existing);
    client.target = "pi-B";
    const result = await registry.open(session("A"));
    expect(result.terminal).toBe(existing);
    expect(displays.create).not.toHaveBeenCalled();
    expect(client.target).toBe("pi-A");
  });

  it("replaces an exited display without restarting the live Pi", async () => {
    const existing = displayTerminal();
    Object.defineProperty(existing, "exitStatus", { value: { code: 0 }, configurable: true });
    const { registry, displays } = setup(existing);
    const result = await registry.open(session("A"));
    expect(result.terminal).not.toBe(existing);
    expect(displays.create).toHaveBeenCalledOnce();
  });

  it("replaces a legacy fixed Pi title but preserves custom titles", async () => {
    const existing = displayTerminal();
    Object.defineProperties(existing, {
      creationOptions: { value: { name: "Pi", cwd: { fsPath: "/project" } } },
      name: { value: "Pi" },
    });
    const { registry, displays } = setup(existing);
    await registry.open(session("A"));
    expect(existing.dispose).toHaveBeenCalledOnce();
    expect(displays.create).toHaveBeenCalledOnce();
  });

  it.each([
    { creationName: undefined, currentName: "Pi" },
    { creationName: "Pi", currentName: "My terminal" },
    { creationName: "My terminal", currentName: "My terminal" },
  ])(
    "does not treat a custom title as the legacy fixed title: %j",
    async ({ creationName, currentName }) => {
      const existing = displayTerminal();
      Object.defineProperties(existing, {
        creationOptions: { value: { name: creationName, cwd: "/project" } },
        name: { value: currentName },
      });
      const { registry, displays } = setup(existing);
      expect((await registry.open(session("A"))).terminal).toBe(existing);
      expect(displays.create).not.toHaveBeenCalled();
      expect(existing.dispose).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "resolveTarget"] as const)(
    "preserves display and selection when %s fails before switching",
    async (method) => {
      const { registry, mocks, displays } = setup();
      const { terminal } = await registry.open(session("A"));
      mocks[method].mockRejectedValueOnce(new Error("query denied"));
      await expect(registry.open(session("B"))).rejects.toThrow("query denied");
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(displays.create).toHaveBeenCalledTimes(1);
      expect(registry.displayedSessionId).toBe("A");
      await registry.open(session("B"));
      expect(registry.displayedSessionId).toBe("B");
    },
  );

  it("does not fall back to restarting a live session when its target is unknown", async () => {
    const { registry, mocks, displays } = setup();
    mocks.resolveTarget.mockResolvedValueOnce(undefined);
    await expect(registry.open(session("A"))).rejects.toThrow("Cannot resolve tmux target");
    expect(displays.create).not.toHaveBeenCalled();
  });

  it("switches a direct child tmux client of the pi-mux Terminal process", async () => {
    const { registry, client, displays, mocks } = setup();
    Object.assign(client, { pid: 456, parentPid: 123 });
    await registry.open(session("A"));
    await registry.open(session("B"));
    expect(displays.create).toHaveBeenCalledOnce();
    expect(mocks.switchClient).toHaveBeenCalledExactlyOnceWith(
      client,
      expect.objectContaining({ sessionId: "B" }),
    );
  });

  it("closes a restored pi-mux parent Terminal when archiving its child client target", async () => {
    const existing = displayTerminal();
    const { registry, client } = setup(existing);
    Object.assign(client, { pid: 456, parentPid: 123, target: "pi-A" });
    await registry.stop("A");
    expect(existing.dispose).toHaveBeenCalledOnce();
  });

  it("waits for its own PID instead of switching an unrelated client", async () => {
    const { registry, mocks } = setup();
    mocks.clients.mockResolvedValueOnce([{ pid: 999, name: "other", target: "pi-B" }]);
    await registry.open(session("A"));
    expect(mocks.clients).toHaveBeenCalledTimes(2);
    expect(mocks.switchClient).not.toHaveBeenCalled();
  });

  it("waits through long lifecycle preparation until both client and target are ready", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, mocks, client, live, displays } = setup();
    live.delete("A");
    let release!: (clients: (typeof client)[]) => void;
    mocks.clients.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mocks.resolveTarget.mockResolvedValueOnce(undefined).mockResolvedValue("pi-A");
    const opening = registry.open(session("A"));
    await vi.waitFor(() => expect(mocks.clients).toHaveBeenCalledOnce());
    vi.setSystemTime(Date.now() + 150_000);
    release([]);
    const result = await opening;
    expect(result.runtime.target).toBe("pi-A");
    expect(mocks.clients).toHaveBeenCalledTimes(2);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(displays.create).toHaveBeenCalledOnce();
  });

  it("rejects a close during attachment even when a matching client is returned", async () => {
    const { registry, mocks, displays, client } = setup();
    mocks.clients.mockImplementationOnce(async () => {
      registry.onTerminalClosed(displays.create.mock.results[0].value);
      return [client];
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/closed/);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(mocks.switchClient).not.toHaveBeenCalled();
  });

  it("stops waiting on user close before the Terminal process ID is available", async () => {
    const { registry, displays, mocks } = setup();
    const create = displays.create.getMockImplementation()!;
    let releasePid!: (pid: number) => void;
    displays.create.mockImplementationOnce((request) => {
      const terminal = create(request);
      Object.defineProperty(terminal, "processId", {
        value: new Promise<number>((resolve) => {
          releasePid = resolve;
        }),
      });
      return terminal;
    });
    let outcome = "pending";
    const opening = registry
      .run(() => registry.open(session("A")))
      .then(
        () => {
          outcome = "connected";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );
    try {
      await vi.waitFor(() => expect(displays.create).toHaveBeenCalledOnce());
      const terminal = displays.create.mock.results[0].value;
      registry.onTerminalClosed(terminal);
      await vi.waitFor(() => expect(outcome).toContain("closed"), { timeout: 500 });
      expect(terminal.dispose).not.toHaveBeenCalled();
      await registry.run(() => registry.open(session("B")));
      expect(registry.displayedSessionId).toBe("B");
      expect(mocks.clients).toHaveBeenCalledOnce();
    } finally {
      releasePid(123);
      await opening;
    }
  });

  it("stops waiting on user close while a query is in flight and ignores its late result", async () => {
    const { registry, displays, mocks, client } = setup();
    let release!: (clients: (typeof client)[]) => void;
    mocks.clients.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let outcome = "pending";
    const opening = registry
      .run(() => registry.open(session("A")))
      .then(
        () => {
          outcome = "connected";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );
    try {
      await vi.waitFor(() => expect(mocks.clients).toHaveBeenCalledOnce());
      registry.onTerminalClosed(displays.create.mock.results[0].value);
      await vi.waitFor(() => expect(outcome).toContain("closed"), { timeout: 500 });
      await registry.run(() => registry.open(session("B")));
      expect(registry.displayedSessionId).toBe("B");
    } finally {
      release([client]);
      await opening;
    }
    expect(registry.displayedSessionId).toBe("B");
  });

  it("fails on Terminal exit during preparation without publishing a selection", async () => {
    const { registry, displays, mocks } = setup();
    mocks.clients.mockImplementationOnce(async () => {
      Object.defineProperty(displays.create.mock.results[0].value, "exitStatus", {
        value: { code: 7 },
        configurable: true,
      });
      return [];
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/exited/);
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("fails on a missing process ID without polling for a client", async () => {
    const { registry, displays, mocks } = setup();
    const create = displays.create.getMockImplementation()!;
    displays.create.mockImplementationOnce((request) => {
      const terminal = create(request);
      Object.defineProperty(terminal, "processId", { value: Promise.resolve(undefined) });
      return terminal;
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/process/);
    expect(mocks.clients).not.toHaveBeenCalled();
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });

  it("removes a failed new display but preserves Pi and allows retry", async () => {
    const { registry, mocks, displays, live } = setup();
    mocks.clients.mockRejectedValueOnce(new Error("client failed"));
    await expect(registry.open(session("A"))).rejects.toThrow("client failed");
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(live.has("A")).toBe(true);
    await registry.open(session("A"));
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a second close event if the display closed during attachment", async () => {
    const { registry, mocks, displays } = setup();
    mocks.clients.mockImplementationOnce(async () => {
      registry.onTerminalClosed(displays.create.mock.results[0].value);
      throw new Error("closed during attachment");
    });
    await expect(registry.open(session("A"))).rejects.toThrow("closed during attachment");
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    await registry.open(session("A"));
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("releases a pending attachment on dispose without closing the display or killing Pi", async () => {
    const { registry, mocks, displays } = setup();
    let release!: (clients: never[]) => void;
    mocks.clients.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const opening = registry.open(session("A")).catch((error: Error) => error);
    await vi.waitFor(() => expect(mocks.clients).toHaveBeenCalledOnce());
    registry.dispose();
    expect(await opening).toBeInstanceOf(Error);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(mocks.closeSession).not.toHaveBeenCalled();
    await expect(registry.presentNew("/project")).rejects.toThrow("disposed");
    release([]);
  });

  it("calls close once even when the session is absent from list and tmux metadata", async () => {
    const { registry, live, mocks } = setup();
    live.delete("A");
    mocks.list.mockRejectedValueOnce(new Error("list must not gate close"));
    await registry.stop("A");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it("closes a stopped displayed session and clears its selection", async () => {
    const { registry, live, mocks } = setup();
    const { terminal } = await registry.open(session("A"));
    live.delete("A");
    await registry.stop("A");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("keeps another selected display even when both Pi share a tmux session", async () => {
    const { registry, live } = setup();
    live.set("B", { ...session("B"), target: "pi-A" });
    const { terminal } = await registry.open(session("B"));
    await registry.stop("A");
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("B");
    expect(live.has("B")).toBe(true);
  });

  it("closes an archived conversation display and clears selection", async () => {
    const { registry, live } = setup();
    const { terminal } = await registry.open(session("A"));
    await registry.stop("A");
    expect(live.has("A")).toBe(false);
    expect(live.has("B")).toBe(true);
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("clears the archived selection even if the user already closed its tab", async () => {
    const { registry } = setup();
    const { terminal } = await registry.open(session("A"));
    registry.onTerminalClosed(terminal);
    await registry.stop("A");
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("stops another conversation without changing the current display", async () => {
    const { registry } = setup();
    const { terminal } = await registry.open(session("B"));
    await registry.stop("A");
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("B");
  });

  it.each(["pi-A", "pi-B"])(
    "closes a restored display only if it showed the archived target: %s",
    async (target) => {
      const existing = displayTerminal();
      const { registry, client } = setup(existing);
      client.target = target;
      await registry.stop("A");
      expect(existing.dispose).toHaveBeenCalledTimes(target === "pi-A" ? 1 : 0);
    },
  );

  it("preserves a restored display showing another Pi in the same tmux session", async () => {
    const existing = displayTerminal();
    const { registry, live, client, mocks } = setup(existing);
    live.set("B", { ...session("B"), target: "pi-A" });
    client.target = "pi-A";
    mocks.resolveClientSessionId.mockResolvedValueOnce("B");
    await registry.stop("A");
    expect(mocks.resolveClientSessionId).toHaveBeenCalledExactlyOnceWith(client);
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(live.has("B")).toBe(true);
  });

  it("calls close with missing restored pane metadata without closing an unrelated display", async () => {
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
    mocks.resolveClientSessionId.mockResolvedValueOnce(undefined);
    await registry.stop("A");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(existing.dispose).not.toHaveBeenCalled();
  });

  it.each(["clients", "resolveClientSessionId"] as const)(
    "still closes the exact ID once without closing an unknown restored display when %s rejects",
    async (method) => {
      const existing = displayTerminal();
      const { registry, client, mocks, live } = setup(existing);
      client.target = "pi-B";
      const dispose = vi.spyOn(existing, "dispose");
      mocks[method].mockRejectedValueOnce(new Error("cannot find client"));
      await registry.stop("A");
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
      expect(dispose).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBeUndefined();
      expect(live.has("A")).toBe(false);
      expect(live.has("B")).toBe(true);
      expect(mocks.newSession).not.toHaveBeenCalled();
    },
  );

  it.each(["clients", "resolveClientSessionId"] as const)(
    "propagates close failure and preserves the restored display after %s rejects",
    async (method) => {
      const existing = displayTerminal();
      const { registry, client, mocks, live } = setup(existing);
      client.target = "pi-A";
      const dispose = vi.spyOn(existing, "dispose");
      mocks[method].mockRejectedValueOnce(new Error("cannot find client"));
      mocks.closeSession.mockRejectedValueOnce(new Error("close denied"));
      await expect(registry.stop("A")).rejects.toThrow("close denied");
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
      expect(dispose).not.toHaveBeenCalled();
      expect(live.has("A")).toBe(true);
      expect(mocks.newSession).not.toHaveBeenCalled();
    },
  );

  it("does not close an unrelated restored display when no archive target exists", async () => {
    const existing = displayTerminal();
    const { registry } = setup(existing);
    await registry.stop("unknown");
    expect(existing.dispose).not.toHaveBeenCalled();
  });

  it("keeps display and selection when stopping Pi fails", async () => {
    const { registry, mocks } = setup();
    const { terminal } = await registry.open(session("A"));
    mocks.closeSession.mockRejectedValueOnce(new Error("stop denied"));
    await expect(registry.stop("A")).rejects.toThrow("stop denied");
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("A");
  });
});

describe("editorTerminals", () => {
  it("identifies ownership by socket path instead of a Terminal named Pi", () => {
    const { store } = fakeRuntimes();
    const unrelated = { name: "Pi", creationOptions: { name: "Pi" } } as vscode.Terminal;
    const owned = {
      creationOptions: { env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketPath } },
    } as unknown as vscode.Terminal;
    windowMock.terminals = [unrelated, owned];
    expect(editorTerminals(store).find()).toBe(owned);
    windowMock.terminals = [unrelated];
    expect(editorTerminals(store).find()).toBeUndefined();
  });

  it("creates a native-title editor Terminal using pi-mux open", () => {
    const { store } = fakeRuntimes();
    windowMock.createTerminal.mockClear();
    editorTerminals(store).create(session("A", "/project with spaces"));
    expect(windowMock.createTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: { fsPath: "/project with spaces" },
      location: 1,
      shellPath: "pi-mux",
      shellArgs: ["open", "A"],
      env: { PI_SESSIONS_DISPLAY_SOCKET: store.socketPath, TMUX: null, TMUX_PANE: null },
      isTransient: false,
    });
    expect(windowMock.createTerminal.mock.calls[0][0]).not.toHaveProperty("name");
  });
});
