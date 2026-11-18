import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import type * as vscode from "vscode";
import { TabInputTerminal } from "vscode";
import { TerminalRegistry } from "../src/terminalRegistry";
import { editorTerminals, NEW_SESSION_COMMAND } from "../src/terminals";
import type { PiMuxCurrentSession, PiMuxWorkspace, PiSession } from "../src/piMux";
import { fakeRuntimes } from "./runtimeFixtures";

const windowMock = vi.hoisted(() => ({
  terminals: [] as vscode.Terminal[],
  createTerminal: vi.fn(),
  state: { focused: false },
  activeTerminal: undefined as vscode.Terminal | undefined,
  tabGroups: { activeTabGroup: { activeTab: undefined as { input: unknown } | undefined } },
}));
vi.mock("vscode", () => ({
  window: windowMock,
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  TerminalLocation: { Editor: 1 },
  TabInputTerminal: class {},
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
    canFocus: vi.fn(() => false),
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
  it("prepares a new-session display and defers other display changes until its session is captured", async () => {
    const { registry, displays, mocks, client } = setup();
    client.attachedId = undefined;
    let releaseCurrent!: (session: PiMuxCurrentSession | undefined) => void;
    mocks.current.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCurrent = resolve;
        }),
    );
    const present = registry.preparePresentation();
    const early = await registry.prepareNew("/project", present);
    expect(early).toBeDefined();
    expect(displays.createNew).toHaveBeenCalledExactlyOnceWith("/project");
    expect(early!.terminal.show).toHaveBeenCalledOnce();

    const switching = registry.open(session("A"));
    await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledOnce());
    expect(mocks.switch).not.toHaveBeenCalled();
    expect(displays.create).not.toHaveBeenCalled();

    releaseCurrent({ id: "new-9", cwd: "/project", file: "/f", target: "pi-new-9" });
    expect(await early!.session).toMatchObject({ sessionId: "new-9", cwd: "/project" });
    expect((await switching).terminal).toBe(early!.terminal);
    expect(mocks.switch).toHaveBeenCalledExactlyOnceWith("A", 123);
    expect(registry.displayedSessionId).toBe("A");
  });

  it("captures the new session before a queued earlier selection connects and keeps arrival order", async () => {
    const { registry, displays, mocks, client, live } = setup();
    client.attachedId = undefined;
    const listImplementation = mocks.list.getMockImplementation()!;
    let releaseList!: (workspaces: PiMuxWorkspace[]) => void;
    const listGate = new Promise<PiMuxWorkspace[]>((resolve) => {
      releaseList = resolve;
    });
    mocks.list.mockReturnValueOnce(listGate);
    const earlier = registry.run(() => registry.open(session("A")));
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    releaseList(await listImplementation());
    const early = await registry.prepareNew("/project", registry.preparePresentation());
    expect(early).toBeDefined();
    expect(early!.terminal.show).toHaveBeenCalledOnce();
    live.set("new-9", { sessionId: "new-9", cwd: "/project", target: "pi-new-9" });
    client.attachedId = "new-9";
    expect(await early!.session).toMatchObject({ sessionId: "new-9", cwd: "/project" });
    await earlier;
    expect(mocks.switch).toHaveBeenCalledExactlyOnceWith("A", 123);
    expect(registry.displayedSessionId).toBe("A");
    await registry.run(() => registry.open({ sessionId: "new-9", cwd: "/project" }));
    expect(mocks.switch).toHaveBeenLastCalledWith("new-9", 123);
    expect(registry.displayedSessionId).toBe("new-9");
    expect(displays.createNew).toHaveBeenCalledOnce();
    expect(displays.create).not.toHaveBeenCalled();
  });

  it("returns no early display when a shared display already exists", async () => {
    const existing = displayTerminal();
    const { registry, displays } = setup(existing);
    const present = registry.preparePresentation();
    expect(await registry.prepareNew("/project", present)).toBeUndefined();
    expect(displays.createNew).not.toHaveBeenCalled();
    expect(existing.show).not.toHaveBeenCalled();
  });

  it("shows immediately and focuses the same display once its process starts", async () => {
    const { registry, displays } = setup();
    const { terminal } = await registry.open(session("A"));
    let ready!: (pid: number | undefined) => void;
    Object.defineProperty(terminal, "processId", {
      value: new Promise<number | undefined>((resolve) => {
        ready = resolve;
      }),
    });
    displays.canFocus.mockReturnValue(true);
    registry.preparePresentation()(terminal);
    expect(terminal.show).toHaveBeenCalledOnce();
    ready(123);
    await vi.waitFor(() => expect(terminal.show).toHaveBeenCalledTimes(2));
    expect(displays.canFocus).toHaveBeenCalledWith(terminal);
    expect(displays.create).toHaveBeenCalledOnce();
  });

  it.each(["newer request", "another input", "closed", "disposed", "missing process"])(
    "does not reclaim focus after %s",
    async (change) => {
      const { registry, displays } = setup();
      const { terminal } = await registry.open(session("A"));
      let ready!: (pid: number | undefined) => void;
      Object.defineProperty(terminal, "processId", {
        value: new Promise<number | undefined>((resolve) => {
          ready = resolve;
        }),
      });
      displays.canFocus.mockReturnValue(true);
      registry.preparePresentation()(terminal);
      if (change === "newer request") registry.preparePresentation();
      if (change === "another input") displays.canFocus.mockReturnValue(false);
      if (change === "closed") registry.onTerminalClosed(terminal);
      if (change === "disposed") registry.dispose();
      ready(change === "missing process" ? undefined : 123);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(terminal.show).toHaveBeenCalledOnce();
    },
  );

  it("does not refocus an obsolete request that finishes after the latest request", async () => {
    const { registry } = setup();
    const { terminal } = await registry.open(session("A"));
    const older = registry.preparePresentation();
    registry.preparePresentation();
    older(terminal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.show).toHaveBeenCalledOnce();
  });
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
      const { registry, mocks } = setup(displayTerminal());
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
    const { registry, mocks } = setup(displayTerminal());
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
    const restored = displayTerminal();
    const { registry, mocks, displays } = setup(restored);
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
    expect(result.terminal).toBe(restored);
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(restored.dispose).not.toHaveBeenCalled();
    expect(displays.create).not.toHaveBeenCalled();
  });

  it("rejects a close during attachment even when a resolved session is returned", async () => {
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
    mocks.current.mockImplementationOnce(async () => {
      registry.onTerminalClosed(existing);
      return { id: "A", cwd: "/project", file: "/sessions/A.jsonl", target: "pi-A" };
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/closed/);
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBeUndefined();
    expect(mocks.switch).not.toHaveBeenCalled();
  });

  it("stops waiting on user close before the Terminal process ID is available", async () => {
    const existing = displayTerminal();
    const { registry, displays } = setup(existing);
    let releasePid!: (pid: number) => void;
    const processId = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releasePid = resolve;
        }),
    );
    Object.defineProperty(existing, "processId", { get: processId });
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
      await vi.waitFor(() => expect(processId).toHaveBeenCalledOnce());
      const terminal = existing;
      registry.onTerminalClosed(terminal);
      await vi.waitFor(() => expect(outcome).toContain("closed"), { timeout: 500 });
      expect(terminal.dispose).not.toHaveBeenCalled();
      await registry.run(() => registry.open(session("B")));
      expect(registry.displayedSessionId).toBe("B");
      expect(displays.create).toHaveBeenCalledOnce();
    } finally {
      releasePid(123);
      await opening;
    }
  });

  it("stops waiting on user close while a query is in flight and ignores its late result", async () => {
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
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
      registry.onTerminalClosed(existing);
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
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
    mocks.current.mockImplementationOnce(async () => {
      Object.defineProperty(existing, "exitStatus", {
        value: { code: 7 },
        configurable: true,
      });
      return undefined;
    });
    await expect(registry.open(session("A"))).rejects.toThrow(/exited/);
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(registry.displayedSessionId).toBeUndefined();
  });

  it("opens a new Terminal without waiting for its process ID", async () => {
    const { registry, displays, mocks } = setup();
    const terminal = displayTerminal();
    const processId = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(terminal, "processId", { get: processId });
    displays.create.mockReturnValueOnce(terminal);
    const result = await registry.open(session("A"));
    expect(result.terminal).toBe(terminal);
    expect(processId).not.toHaveBeenCalled();
    expect(mocks.current).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("preserves Pi when creating a new display fails and allows retry", async () => {
    const { registry, mocks, displays, live } = setup();
    displays.create.mockImplementationOnce(() => {
      throw new Error("creation failed");
    });
    await expect(registry.open(session("A"))).rejects.toThrow("creation failed");
    expect(live.has("A")).toBe(true);
    expect(mocks.current).not.toHaveBeenCalled();
    await registry.open(session("A"));
    expect(displays.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    { intent: "unarchive" as const, previousTemporary: false },
    { intent: "unarchive" as const, previousTemporary: true },
    { intent: "select" as const, previousTemporary: false },
    { intent: "select" as const, previousTemporary: true },
  ])(
    "restores the previous live display after creation fails: %j",
    async ({ intent, previousTemporary }) => {
      const { registry, displays, live, temporary, mocks } = setup();
      if (previousTemporary) temporary.add("A");
      const first = await registry.open({
        ...session("A"),
        ...(previousTemporary ? { temporary: true as const } : {}),
      });
      const original = live.get("A");
      live.delete("B");
      displays.create.mockImplementationOnce(() => {
        throw new Error("creation failed");
      });
      await expect(
        registry.open(
          { ...session("B"), ...(intent === "select" ? { temporary: true as const } : {}) },
          intent,
        ),
      ).rejects.toThrow("creation failed; showing previous Pi session A");
      const restored = await registry.displayForSession("A");
      expect(restored).toBeDefined();
      expect(restored).not.toBe(first.terminal);
      expect(restored?.show).toHaveBeenCalledOnce();
      expect(first.terminal.dispose).toHaveBeenCalledOnce();
      expect(displays.create).toHaveBeenCalledTimes(3);
      expect(displays.create).toHaveBeenLastCalledWith({
        ...session("A"),
        ...(previousTemporary ? { temporary: true } : {}),
      });
      expect(live.get("A")).toBe(original);
      expect(temporary.has("A")).toBe(previousTemporary);
      expect(registry.displayedSessionId).toBe("A");
      expect(mocks.current).not.toHaveBeenCalled();
      expect(mocks.newSession).not.toHaveBeenCalled();
      expect(mocks.closeTemporarySession).not.toHaveBeenCalled();
    },
  );

  it("does not restart a previous Pi that exited before restoration", async () => {
    const { registry, displays, live } = setup();
    await registry.open(session("A"));
    displays.create.mockImplementationOnce(() => {
      live.delete("A");
      throw new Error("creation failed");
    });
    await expect(registry.open(session("B"), "unarchive")).rejects.toThrow("creation failed");
    expect(displays.create).toHaveBeenCalledTimes(2);
    expect(await registry.displayForSession("A")).toBeUndefined();
    expect(live.has("A")).toBe(false);
  });

  it.each(["list", "create"] as const)(
    "reports the original and restoration errors when %s fails",
    async (failure) => {
      const { registry, displays, mocks } = setup();
      await registry.open(session("A"));
      displays.create.mockImplementationOnce(() => {
        if (failure === "list") mocks.list.mockRejectedValueOnce(new Error("recovery denied"));
        throw new Error("creation failed");
      });
      if (failure === "create")
        displays.create.mockImplementationOnce(() => {
          throw new Error("recovery denied");
        });
      await expect(registry.open(session("B"), "unarchive")).rejects.toThrow(
        "creation failed; failed to restore display: recovery denied",
      );
      expect(displays.create).toHaveBeenCalledTimes(failure === "list" ? 2 : 3);
      expect(await registry.displayForSession("A")).toBeUndefined();
      expect(registry.displayedSessionId).toBe("A");
    },
  );

  it("uses the current temporary attribute when restoring an existing Pi", async () => {
    const { registry, displays, temporary } = setup();
    await registry.open(session("A"));
    displays.create.mockImplementationOnce(() => {
      temporary.add("A");
      throw new Error("creation failed");
    });
    await expect(registry.open(session("B"), "unarchive")).rejects.toThrow(
      "showing previous Pi session A",
    );
    expect(displays.create).toHaveBeenLastCalledWith({ ...session("A"), temporary: true });
    expect(temporary.has("A")).toBe(true);
  });

  it("restores an unsaved empty Pi without waiting for the new process ID", async () => {
    const { registry, displays, emptyIds, live } = setup();
    await registry.open(session("A"));
    emptyIds.add("A");
    const terminal = displayTerminal();
    const processId = vi.fn(() => new Promise<number>(() => {}));
    Object.defineProperty(terminal, "processId", { get: processId });
    displays.create.mockImplementationOnce(() => {
      throw new Error("creation failed");
    });
    displays.create.mockReturnValueOnce(terminal);
    await expect(registry.open(session("B"), "unarchive")).rejects.toThrow(
      "showing previous Pi session A",
    );
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(live.has("A")).toBe(true);
    expect(await registry.displayForSession("A")).toBe(terminal);
  });

  it.each(["request", "dispose", "old workspace", "new workspace"] as const)(
    "does not restore after %s cancellation while checking Pi",
    async (cancellation) => {
      const { registry, displays, mocks } = setup();
      await registry.open(session("A"));
      const controller = new AbortController();
      const snapshot = await mocks.list.getMockImplementation()!();
      let release!: () => void;
      const pending = new Promise<typeof snapshot>((resolve) => {
        release = () => resolve(snapshot);
      });
      displays.create.mockImplementationOnce(() => {
        mocks.list.mockReturnValueOnce(pending);
        throw new Error("creation failed");
      });
      const opening = registry
        .open(session("B", "/other"), "unarchive", controller.signal)
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
      if (cancellation === "request") controller.abort(new Error("request cancelled"));
      if (cancellation === "dispose") registry.dispose();
      if (cancellation === "old workspace") registry.cancelDisplayRecovery("/project");
      if (cancellation === "new workspace") registry.cancelDisplayRecovery("/other");
      release();
      expect(await opening).toBeInstanceOf(Error);
      expect(displays.create).toHaveBeenCalledTimes(2);
      expect(await registry.displayForSession("A")).toBeUndefined();
    },
  );

  it("remembers workspace cancellation received before a replacement fails", async () => {
    const { registry, displays, mocks } = setup();
    await registry.open(session("A"));
    const snapshot = await mocks.list.getMockImplementation()!();
    let release!: () => void;
    mocks.list.mockReturnValueOnce(
      new Promise<typeof snapshot>((resolve) => {
        release = () => resolve(snapshot);
      }),
    );
    displays.create.mockImplementationOnce(() => {
      throw new Error("creation failed");
    });
    const opening = registry
      .open(session("B", "/other"), "unarchive")
      .catch((error: unknown) => error);
    registry.cancelDisplayRecovery("/project");
    release();
    expect(await opening).toBeInstanceOf(Error);
    expect(displays.create).toHaveBeenCalledTimes(2);
    expect(await registry.displayForSession("A")).toBeUndefined();
  });

  it.each(["request", "dispose", "workspace"] as const)(
    "closes an unpresented recovery display after %s cancellation",
    async (cancellation) => {
      const { registry, displays } = setup();
      const create = displays.create.getMockImplementation()!;
      await registry.open(session("A"));
      const controller = new AbortController();
      let recovered!: vscode.Terminal;
      displays.create.mockImplementationOnce(() => {
        throw new Error("creation failed");
      });
      displays.create.mockImplementationOnce((request) => {
        recovered = create(request);
        queueMicrotask(() => {
          if (cancellation === "request") controller.abort(new Error("request cancelled"));
          if (cancellation === "dispose") registry.dispose();
          if (cancellation === "workspace") registry.cancelDisplayRecovery("/project");
        });
        return recovered;
      });
      await expect(
        registry.open(session("B"), "unarchive", controller.signal),
      ).rejects.toBeInstanceOf(Error);
      expect(recovered.show).not.toHaveBeenCalled();
      expect(recovered.dispose).toHaveBeenCalledOnce();
      expect(await registry.displayForSession("A")).toBeUndefined();
    },
  );

  it("does not wait for a second close event if the display closed during attachment", async () => {
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
    mocks.current.mockImplementationOnce(async () => {
      registry.onTerminalClosed(existing);
      throw new Error("closed during attachment");
    });
    await expect(registry.open(session("A"))).rejects.toThrow("closed during attachment");
    expect(existing.dispose).not.toHaveBeenCalled();
    await registry.open(session("A"));
    expect(registry.displayedSessionId).toBe("A");
  });

  it("releases a pending attachment on dispose without closing the display or killing Pi", async () => {
    const existing = displayTerminal();
    const { registry, mocks } = setup(existing);
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
    expect(existing.dispose).not.toHaveBeenCalled();
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

  it("waits for an opening client before archiving into a replacement on the same tab", async () => {
    const { registry, mocks, displays, client, live } = setup();
    const cwd = process.cwd();
    const { terminal } = await registry.open(session("A", cwd));
    expect(mocks.current).not.toHaveBeenCalled();
    client.attachedId = undefined;
    let attach!: (current: PiMuxCurrentSession) => void;
    const attaching = new Promise<PiMuxCurrentSession>((resolve) => {
      attach = resolve;
    });
    mocks.current.mockResolvedValueOnce(undefined).mockReturnValueOnce(attaching);
    const stopping = registry.run(() => registry.stop("A", { replacement: session("B", cwd) }));
    try {
      await vi.waitFor(() => expect(mocks.current).toHaveBeenCalledTimes(2), { timeout: 500 });
      expect(mocks.closeSession).not.toHaveBeenCalled();
      expect(mocks.switch).not.toHaveBeenCalled();
      expect(terminal.dispose).not.toHaveBeenCalled();
      client.attachedId = "A";
      attach({ id: "A", cwd, file: "/sessions/A.jsonl", target: "pi-A" });
      expect(await stopping).toEqual({ switched: true, switchError: undefined });
      expect(mocks.switch).toHaveBeenCalledExactlyOnceWith("B", 123);
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(displays.create).toHaveBeenCalledOnce();
      expect(registry.displayedSessionId).toBe("B");
      expect(live.has("A")).toBe(false);
      expect(live.has("B")).toBe(true);
    } finally {
      attach({ id: "A", cwd, file: "/sessions/A.jsonl", target: "pi-A" });
      await stopping;
    }
  });

  it.each(["closed", "exited", "lookup failed"] as const)(
    "finishes Archive when an unattached display fails: %s",
    async (failure) => {
      const { registry, mocks, live } = setup();
      const cwd = process.cwd();
      const { terminal } = await registry.open(session("A", cwd));
      mocks.current.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        if (failure === "closed") registry.onTerminalClosed(terminal);
        if (failure === "exited") {
          Object.defineProperty(terminal, "exitStatus", { value: { code: 1 }, configurable: true });
        }
        if (failure === "lookup failed") throw new Error(failure);
        return undefined;
      });
      const result = await registry.run(() =>
        registry.stop("A", { replacement: session("B", cwd) }),
      );
      expect(result.switched).toBe(false);
      expect(result.switchError).toContain(failure);
      expect(mocks.switch).not.toHaveBeenCalled();
      expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith("A");
      expect(registry.displayedSessionId).toBeUndefined();
      expect(live.has("A")).toBe(false);
      expect(live.has("B")).toBe(true);
    },
  );

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
  it.each(["ready", "another window", "another terminal", "another editor"])(
    "allows delayed focus only on its active editor Terminal (%s)",
    (destination) => {
      const terminal = displayTerminal();
      windowMock.state.focused = destination !== "another window";
      windowMock.activeTerminal = destination === "another terminal" ? displayTerminal() : terminal;
      windowMock.tabGroups.activeTabGroup.activeTab = {
        input: destination === "another editor" ? {} : new TabInputTerminal(),
      };
      expect(editorTerminals().canFocus(terminal)).toBe(destination === "ready");
      windowMock.state.focused = false;
    },
  );
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

  it("creates a new-session Terminal that runs pi-mux new in the requested cwd from the home directory", () => {
    windowMock.createTerminal.mockClear();
    editorTerminals().createNew("/project with 'quotes'; && spaces");
    expect(windowMock.createTerminal).toHaveBeenCalledExactlyOnceWith({
      cwd: { fsPath: homedir() },
      location: 1,
      shellPath: "sh",
      shellArgs: ["-c", NEW_SESSION_COMMAND, "pi-mux-new", "/project with 'quotes'; && spaces"],
      env: { PI_SESSIONS_DISPLAY: "1", TMUX: null, TMUX_PANE: null },
      isTransient: false,
    });
  });
});
