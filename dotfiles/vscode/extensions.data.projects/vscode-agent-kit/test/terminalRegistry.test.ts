import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import type * as vscode from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals } from "../src/terminals";
import type { PiMuxCurrentSession, PiSession } from "../src/piMux";
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
    find: vi.fn(() => restored),
  };
  const registry = new TerminalRegistry(displays, runtimes.mux);
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
  it("opens with a request signal when static AbortSignal helpers are unavailable", async () => {
    const { registry } = setup();
    const controller = new AbortController();
    vi.stubGlobal("AbortSignal", {});
    try {
      await registry.open(session("A"), "select", controller.signal);
      expect(registry.displayedSessionId).toBe("A");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an already aborted request before creating a display", async () => {
    const { registry, displays, mocks } = setup();
    const controller = new AbortController();
    const reason = new Error("workspace removed");
    controller.abort(reason);
    await expect(registry.open(session("A"), "select", controller.signal)).rejects.toBe(reason);
    expect(displays.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("handles cancellation between display creation and attachment without an unhandled rejection", async () => {
    const { registry, displays, mocks } = setup();
    const controller = new AbortController();
    const reason = new Error("workspace removed before attachment");
    const added = vi.spyOn(controller.signal, "addEventListener");
    const create = displays.create.getMockImplementation()!;
    displays.create.mockImplementation((request) => {
      const terminal = create(request);
      queueMicrotask(() => controller.abort(reason));
      return terminal;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(registry.open(session("A"), "select", controller.signal)).rejects.toBe(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(added).not.toHaveBeenCalled();
      expect(mocks.current).not.toHaveBeenCalled();
      expect(registry.displayedSessionId).toBeUndefined();
      expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it.each(["success", "failure", "cancel"])(
    "removes the request abort listener after attachment ends with %s",
    async (outcome) => {
      const { registry, mocks } = setup();
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const reason = new Error("workspace removed");
      let release!: (current: PiMuxCurrentSession | undefined) => void;
      if (outcome === "failure") mocks.current.mockRejectedValueOnce(new Error("lookup denied"));
      if (outcome === "cancel") {
        mocks.current.mockReturnValueOnce(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
      }
      const opening = registry.open(session("A"), "select", controller.signal);
      if (outcome === "cancel") {
        const cancelled = opening.catch((error: unknown) => error);
        await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
        controller.abort(reason);
        expect(await cancelled).toBe(reason);
        release(undefined);
      } else if (outcome === "failure") {
        await expect(opening).rejects.toThrow("lookup denied");
      } else {
        await opening;
      }
      expect(added).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function), { once: true });
      const listener = added.mock.calls[0][1];
      expect(removed).toHaveBeenCalledExactlyOnceWith("abort", listener);
      if (outcome === "success") {
        controller.abort(reason);
        expect(registry.displayedSessionId).toBe("A");
      }
    },
  );

  it("switches live same-cwd conversations on one display in arrival order", async () => {
    const { registry, mocks, live, displays } = setup();
    const original = [...live.values()];
    await Promise.all(
      ["A", "B", "A", "B"].map((id) => registry.run(() => registry.open(session(id)))),
    );
    expect(displays.create).toHaveBeenCalledTimes(1);
    expect(mocks.switch.mock.calls.map(([sessionId]) => sessionId)).toEqual(["B", "A", "B"]);
    expect(mocks.switch.mock.calls.every(([, pid]) => pid === 123)).toBe(true);
    expect([...live.values()]).toEqual(original);
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("B");
  });

  it("runs explicit normal open even with the same temporary Pi and existing Terminal", async () => {
    const { registry, displays, mocks, temporary, live } = setup();
    temporary.add("A");
    const original = live.get("A");
    const first = await registry.open({ ...session("A"), temporary: true });
    expect(temporary.has("A")).toBe(true);
    const next = await registry.open(session("A"), "unarchive");
    expect(next.terminal).not.toBe(first.terminal);
    expect(first.terminal.dispose).toHaveBeenCalledOnce();
    expect(displays.create).toHaveBeenLastCalledWith(session("A"));
    expect(temporary.has("A")).toBe(false);
    expect(live.get("A")).toBe(original);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(mocks.closeTemporarySession).not.toHaveBeenCalled();
  });

  it("reselects a temporary Pi without promoting or restarting it", async () => {
    const { registry, displays, temporary, live } = setup();
    temporary.add("A");
    const original = live.get("A");
    const request = { ...session("A"), temporary: true as const };
    const first = await registry.open(request);
    expect((await registry.open(request)).terminal).toBe(first.terminal);
    expect(displays.create).toHaveBeenCalledExactlyOnceWith(request);
    expect(temporary.has("A")).toBe(true);
    expect(live.get("A")).toBe(original);
  });

  it("keeps a normal Pi normal when opened temporarily from a stale archived row", async () => {
    const { registry, temporary, live } = setup();
    const original = live.get("A");
    await registry.open({ ...session("A"), temporary: true });
    expect(temporary.has("A")).toBe(false);
    expect(live.get("A")).toBe(original);
  });

  it("switches across different cwds on one display without restarting live Pi", async () => {
    const { registry, displays, live, mocks } = setup();
    const original = [...live.values()];
    for (const id of ["A", "B", "A", "B"]) {
      await registry.open(session(id, id === "A" ? "/project" : "/worktree"));
    }
    expect(displays.create).toHaveBeenCalledOnce();
    expect(mocks.switch.mock.calls.map(([sessionId]) => sessionId)).toEqual(["B", "A", "B"]);
    expect([...live.values()]).toEqual(original);
  });

  it("recreates the display when the selected Pi is not running", async () => {
    const { registry, displays, live, mocks } = setup();
    const first = await registry.open(session("A"));
    live.delete("B");
    const next = await registry.open(session("B"));
    expect(first.terminal.dispose).toHaveBeenCalledOnce();
    expect(next.terminal).not.toBe(first.terminal);
    expect(displays.create.mock.calls.map(([request]) => request.sessionId)).toEqual(["A", "B"]);
    expect(mocks.switch).not.toHaveBeenCalled();
    expect(live.has("B")).toBe(true);
    expect(live.has("A")).toBe(true);
  });

  it("waits for close completion before recreating a display or handling a queued selection", async () => {
    const { registry, displays, live } = setup();
    const { terminal } = await registry.open(session("A"));
    live.delete("B");
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
    expect(a.terminal).toBe(b.terminal);
    expect(displays.create).toHaveBeenCalledTimes(2);
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

  it("rediscovers an owned Terminal after extension host restart", async () => {
    const existing = displayTerminal();
    const { registry, displays, client } = setup(existing);
    client.attachedId = "B";
    const result = await registry.open(session("A"));
    expect(result.terminal).toBe(existing);
    expect(displays.create).not.toHaveBeenCalled();
    expect(client.attachedId).toBe("A");
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

  it.each(["list", "switch"] as const)(
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

  it("switches while the client attachment cannot be resolved yet", async () => {
    const { registry, mocks } = setup();
    mocks.current.mockResolvedValueOnce(undefined);
    await registry.open(session("A"));
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(mocks.current).toHaveBeenNthCalledWith(1, 123);
    expect(mocks.switch).toHaveBeenCalledExactlyOnceWith("A", 123);
  });

  it("switches a direct child tmux client of the pi-mux Terminal process", async () => {
    const { registry, client, displays, mocks } = setup();
    Object.assign(client, { pid: 456, parentPid: 123 });
    await registry.open(session("A"));
    await registry.open(session("B"));
    expect(displays.create).toHaveBeenCalledOnce();
    expect(mocks.switch).toHaveBeenCalledExactlyOnceWith("B", 123);
  });

  it("closes a restored pi-mux parent Terminal when archiving its child client target", async () => {
    const existing = displayTerminal();
    const { registry, client } = setup(existing);
    Object.assign(client, { pid: 456, parentPid: 123, attachedId: "A" });
    await registry.stop("A");
    expect(existing.dispose).toHaveBeenCalledOnce();
  });

  it("waits through long lifecycle preparation until the client attaches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, mocks, live, displays } = setup();
    live.delete("A");
    let release!: (session: PiMuxCurrentSession | undefined) => void;
    mocks.current.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const opening = registry.open(session("A"));
    await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
    vi.setSystemTime(Date.now() + 150_000);
    release(undefined);
    const result = await opening;
    expect(result.runtime.target).toBe("pi-A");
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(displays.create).toHaveBeenCalledOnce();
  });

  it("rejects a close during attachment even when a resolved session is returned", async () => {
    const { registry, mocks, displays } = setup();
    mocks.current.mockImplementationOnce(async () => {
      registry.onTerminalClosed(displays.create.mock.results[0].value);
      return { id: "A", cwd: "/project", file: "/sessions/A.jsonl", target: "pi-A" };
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/closed/);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(mocks.switch).not.toHaveBeenCalled();
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
      expect(mocks.current).toHaveBeenCalledOnce();
    } finally {
      releasePid(123);
      await opening;
    }
  });

  it("stops waiting on user close while a query is in flight and ignores its late result", async () => {
    const { registry, displays, mocks } = setup();
    let release!: (session: PiMuxCurrentSession | undefined) => void;
    mocks.current.mockImplementationOnce(
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
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
      registry.onTerminalClosed(displays.create.mock.results[0].value);
      await vi.waitFor(() => expect(outcome).toContain("closed"), { timeout: 500 });
      await registry.run(() => registry.open(session("B")));
      expect(registry.displayedSessionId).toBe("B");
    } finally {
      release(undefined);
      await opening;
    }
    expect(registry.displayedSessionId).toBe("B");
  });

  it("fails on Terminal exit during preparation without publishing a selection", async () => {
    const { registry, displays, mocks } = setup();
    mocks.current.mockImplementationOnce(async () => {
      Object.defineProperty(displays.create.mock.results[0].value, "exitStatus", {
        value: { code: 7 },
        configurable: true,
      });
      return undefined;
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/exited/);
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("fails on a missing process ID without querying the client", async () => {
    const { registry, displays, mocks } = setup();
    const create = displays.create.getMockImplementation()!;
    displays.create.mockImplementationOnce((request) => {
      const terminal = create(request);
      Object.defineProperty(terminal, "processId", { value: Promise.resolve(undefined) });
      return terminal;
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/process/);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });

  it("removes a failed new display but preserves Pi and allows retry", async () => {
    const { registry, mocks, displays, live } = setup();
    mocks.current.mockRejectedValueOnce(new Error("client failed"));
    await expect(registry.open(session("A"))).rejects.toThrow("client failed");
    expect(displays.create.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(live.has("A")).toBe(true);
    await registry.open(session("A"));
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a second close event if the display closed during attachment", async () => {
    const { registry, mocks, displays } = setup();
    mocks.current.mockImplementationOnce(async () => {
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
    let release!: (session: PiMuxCurrentSession | undefined) => void;
    mocks.current.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const opening = registry.open(session("A")).catch((error: Error) => error);
    await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
    registry.dispose();
    expect(await opening).toBeInstanceOf(Error);
    expect(displays.create.mock.results[0].value.dispose).not.toHaveBeenCalled();
    expect(mocks.closeSession).not.toHaveBeenCalled();
    await expect(registry.open(session("A"))).rejects.toThrow("disposed");
    release(undefined);
  });

  it("calls close once even when the session is absent from list and client resolution", async () => {
    const { registry, live, mocks } = setup();
    live.delete("A");
    mocks.list.mockRejectedValueOnce(new Error("list must not gate close"));
    await registry.stop("A");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.current).not.toHaveBeenCalled();
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

  it("switches the attached client before stopping the displayed Pi without closing its tab", async () => {
    const { registry, live, mocks, displays, client } = setup();
    const cwd = process.cwd();
    const { terminal } = await registry.open(session("A", cwd));
    const close = mocks.closeSession.getMockImplementation()!;
    mocks.closeSession.mockImplementationOnce(async (id) => {
      expect(client.attachedId).toBe("B");
      return close(id);
    });
    expect(await registry.stop("A", { replacement: session("B", cwd) })).toEqual({
      switched: true,
      switchError: undefined,
    });
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(displays.create).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBe("B");
    expect(live.has("A")).toBe(false);
    expect(live.has("B")).toBe(true);
  });

  it("restores the original client when stopping after a switch fails", async () => {
    const { registry, live, mocks, client } = setup();
    const cwd = process.cwd();
    const { terminal } = await registry.open(session("A", cwd));
    mocks.closeSession.mockRejectedValueOnce(new Error("close denied"));
    await expect(registry.stop("A", { replacement: session("B", cwd) })).rejects.toThrow(
      "close denied",
    );
    expect(client.attachedId).toBe("A");
    expect(registry.displayedSessionId).toBe("A");
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(live.has("A")).toBe(true);
  });

  it("closes the display and stops Pi if its replacement disappeared", async () => {
    const { registry, live } = setup();
    const cwd = process.cwd();
    const { terminal } = await registry.open(session("A", cwd));
    live.delete("B");
    const result = await registry.stop("A", { replacement: session("B", cwd) });
    expect(result.switchError).toContain("no longer running");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has("A")).toBe(false);
    expect(live.has("B")).toBe(false);
  });

  it("switches a restored display when its attached session is archived", async () => {
    const cwd = process.cwd();
    const existing = displayTerminal(cwd);
    const { registry, client, displays, live } = setup(existing);
    live.set("A", { ...session("A", cwd), target: "pi-A" });
    client.attachedId = "A";
    await registry.stop("A", { replacement: session("B", cwd) });
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(displays.create).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBe("B");
    expect(client.attachedId).toBe("B");
  });

  it("uses a confirmed restored display when later client lookup fails", async () => {
    const cwd = process.cwd();
    const existing = displayTerminal(cwd);
    const { registry, client, mocks, live } = setup(existing);
    live.set("A", { ...session("A", cwd), target: "pi-A" });
    client.attachedId = "A";
    const current = { id: "A", cwd, file: "/sessions/A.jsonl", target: "pi-A" };
    mocks.current
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockRejectedValue(new Error("client lookup denied"));
    const confirmedDisplay = await registry.displayForSession("A");
    expect(confirmedDisplay).toBe(existing);
    const stopped = await registry.stop("A", {
      replacement: session("B", cwd),
      confirmedDisplay,
    });
    expect(stopped.switchError).toContain("client lookup denied");
    expect(mocks.closeSession).toHaveBeenCalledWith("A");
    expect(live.has("A")).toBe(false);
    expect(existing.dispose).toHaveBeenCalledOnce();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("stops Pi without closing an unconfirmed restored display when client lookup fails", async () => {
    const existing = displayTerminal();
    const { registry, mocks, live } = setup(existing);
    mocks.current.mockRejectedValue(new Error("client lookup denied"));
    const stopped = await registry.stop("A");
    expect(stopped).toEqual({ switched: false, switchError: undefined });
    expect(mocks.closeSession).toHaveBeenCalledWith("A");
    expect(live.has("A")).toBe(false);
    expect(existing.dispose).not.toHaveBeenCalled();
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

  it.each(["A", "B"])(
    "closes a restored display only if it showed the archived session: pi-%s",
    async (attached) => {
      const existing = displayTerminal();
      const { registry, client } = setup(existing);
      client.attachedId = attached;
      await registry.stop("A");
      expect(existing.dispose).toHaveBeenCalledTimes(attached === "A" ? 1 : 0);
    },
  );

  it("preserves a restored display showing another Pi in the same tmux session", async () => {
    const existing = displayTerminal();
    const { registry, live, client, mocks } = setup(existing);
    live.set("B", { ...session("B"), target: "pi-A" });
    client.attachedId = "B";
    await registry.stop("A");
    expect(mocks.current).toHaveBeenCalledExactlyOnceWith(123);
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(live.has("B")).toBe(true);
  });

  it("still closes the exact ID once without closing an unknown restored display when current rejects", async () => {
    const existing = displayTerminal();
    const { registry, client, mocks, live } = setup(existing);
    client.attachedId = "B";
    const dispose = vi.spyOn(existing, "dispose");
    mocks.current.mockRejectedValueOnce(new Error("cannot find client"));
    await registry.stop("A");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(live.has("A")).toBe(false);
    expect(live.has("B")).toBe(true);
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it("propagates close failure and preserves the restored display after current rejects", async () => {
    const existing = displayTerminal();
    const { registry, client, mocks, live } = setup(existing);
    client.attachedId = "A";
    const dispose = vi.spyOn(existing, "dispose");
    mocks.current.mockRejectedValueOnce(new Error("cannot find client"));
    mocks.closeSession.mockRejectedValueOnce(new Error("close denied"));
    await expect(registry.stop("A")).rejects.toThrow("close denied");
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
    expect(dispose).not.toHaveBeenCalled();
    expect(live.has("A")).toBe(true);
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

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
  it("identifies ownership by a fixed environment marker instead of a Terminal named Pi", () => {
    const unrelated = { name: "Pi", creationOptions: { name: "Pi" } } as vscode.Terminal;
    const owned = {
      creationOptions: { env: { PI_SESSIONS_DISPLAY: "1" } },
    } as unknown as vscode.Terminal;
    windowMock.terminals = [unrelated, owned];
    expect(editorTerminals().find()).toBe(owned);
    windowMock.terminals = [unrelated];
    expect(editorTerminals().find()).toBeUndefined();
  });

  it("passes temporary open as argv to the native Terminal", () => {
    windowMock.createTerminal.mockClear();
    editorTerminals().create({ ...session("custom-ID"), temporary: true });
    expect(windowMock.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "pi-mux",
        shellArgs: ["open", "--temporary", "custom-ID"],
      }),
    );
  });

  it("creates a native-title editor Terminal using pi-mux open in the user's home", () => {
    windowMock.createTerminal.mockClear();
    editorTerminals().create(session("A", "/project with spaces"));
    expect(windowMock.createTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: { fsPath: homedir() },
      location: 1,
      shellPath: "pi-mux",
      shellArgs: ["open", "A"],
      env: { PI_SESSIONS_DISPLAY: "1", TMUX: null, TMUX_PANE: null },
      isTransient: false,
    });
    expect(windowMock.createTerminal.mock.calls[0][0]).not.toHaveProperty("name");
  });
});
