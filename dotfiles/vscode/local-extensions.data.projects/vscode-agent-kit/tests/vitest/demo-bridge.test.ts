import { describe, expect, it, vi } from "vitest";
import {
  createDemoBridge,
  type DemoBridgeRequest,
  type DemoState,
} from "../../stories/demo-bridge";

interface DemoSession {
  sessionId: string;
  displayName: string;
  isInactive: boolean;
  state?: string;
}

interface CapturedState {
  groups: { cwd: string; registered: boolean; sessions: DemoSession[] }[];
  displayedSessionId?: string;
}

interface DemoBridgeHandle {
  bridge: {
    postMessage(request: DemoBridgeRequest): void;
    onMessage(callback: (message: unknown) => void): void;
  };
  postSessions(): void;
  reset(demoState: DemoState): void;
}

function setup() {
  const { bridge, postSessions, reset }: DemoBridgeHandle = createDemoBridge();
  const states: CapturedState[] = [];
  bridge.onMessage((message) => {
    const sessionMessage = message as { type?: string; state?: CapturedState };
    if (sessionMessage.type === "sessions" && sessionMessage.state !== undefined) {
      states.push(sessionMessage.state);
    }
  });
  return {
    bridge,
    postSessions,
    reset,
    states,
    last: () => states.at(-1) as CapturedState,
  };
}

function sessions(state: CapturedState): DemoSession[] {
  return state.groups.flatMap((group) => group.sessions);
}

function sessionIds(state: CapturedState): string[] {
  return sessions(state).map((session) => session.sessionId);
}

const projectCurrentId = "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10";
const projectInactiveId = "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61";
const piToolsCurrentId = "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72";
const piToolsOtherId = "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83";
const worktreeId = "5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94";

describe("createDemoBridge", () => {
  it("replays current sessions with the connection request id", () => {
    const demo = createDemoBridge();
    const listener = vi.fn();
    demo.bridge.onMessage(listener);
    demo.bridge.postMessage({ type: "ready", requestId: "connection-1" });
    expect(listener).toHaveBeenLastCalledWith({
      type: "sessions",
      state: expect.any(Object),
      requestId: "connection-1",
    });
    const state = listener.mock.lastCall?.[0].state;
    demo.postSessions();
    expect(listener).toHaveBeenLastCalledWith({ type: "sessions", state });
  });
  it("sends every session with deactivate marks and the displayed session", () => {
    const { postSessions, last } = setup();

    postSessions();

    expect(sessionIds(last())).toHaveLength(5);
    expect(sessions(last()).map((session) => [session.sessionId, session.isInactive])).toEqual([
      [piToolsCurrentId, false],
      [piToolsOtherId, false],
      [worktreeId, false],
      [projectCurrentId, false],
      [projectInactiveId, true],
    ]);
    expect(last().displayedSessionId).toBe(projectCurrentId);
  });

  it("deactivates the requested session", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "deactivateSession", sessionId: projectCurrentId });
    const state = last();
    expect(sessionIds(state)).toContain(projectCurrentId);
    const inactive = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(inactive?.isInactive).toBe(true);
    expect(inactive?.state).toBeUndefined();
    expect(state.displayedSessionId).toBeUndefined();
    const untouched = sessions(state).find((session) => session.sessionId === piToolsCurrentId);
    expect(untouched?.isInactive).toBe(false);
  });

  it("finishes deactivate and activate requests with their request ids", () => {
    const demo = createDemoBridge();
    const finished: { type?: string; requestId?: string }[] = [];
    demo.bridge.onMessage((message) => {
      const completion = message as { type?: string; requestId?: string };
      if (completion.type === "deactivateFinished" || completion.type === "activateFinished")
        finished.push(completion);
    });
    demo.bridge.postMessage({
      type: "deactivateSession",
      sessionId: projectCurrentId,
      requestId: "deactivate-request",
    });
    demo.bridge.postMessage({
      type: "activateSession",
      sessionId: projectInactiveId,
      requestId: "activate-request",
    });
    expect(finished).toEqual([
      { type: "deactivateFinished", requestId: "deactivate-request" },
      { type: "activateFinished", requestId: "activate-request" },
    ]);
    demo.bridge.postMessage({ type: "deactivateSession", sessionId: piToolsCurrentId });
    expect(finished).toHaveLength(2);
  });

  it("sends the sessions update before the request completion like the extension host", () => {
    const demo = createDemoBridge();
    const types: string[] = [];
    demo.bridge.onMessage((message) => {
      const { type } = message as { type: string };
      if (type === "deactivateSession" || type === "activateSession") return;
      types.push(type);
    });
    demo.bridge.postMessage({
      type: "deactivateSession",
      sessionId: projectCurrentId,
      requestId: "deactivate-request",
    });
    demo.bridge.postMessage({
      type: "activateSession",
      sessionId: projectInactiveId,
      requestId: "activate-request",
    });
    expect(types).toEqual(["sessions", "deactivateFinished", "sessions", "activateFinished"]);
  });

  it("clears selection when deactivating the displayed session even with an active same-cwd row", () => {
    const { bridge, last } = setup();
    bridge.postMessage({ type: "activateSession", sessionId: projectInactiveId });
    bridge.postMessage({ type: "deactivateSession", sessionId: projectCurrentId });
    expect(last().displayedSessionId).toBeUndefined();
    expect(
      sessions(last()).find((session) => session.sessionId === projectCurrentId)?.isInactive,
    ).toBe(true);
    expect(
      sessions(last()).find((session) => session.sessionId === projectInactiveId)?.isInactive,
    ).toBe(false);
  });

  it("keeps another displayed session when deactivating and never restores a stopped phase", () => {
    const { bridge, last } = setup();
    bridge.postMessage({ type: "deactivateSession", sessionId: piToolsCurrentId });
    expect(last().displayedSessionId).toBe(projectCurrentId);
    bridge.postMessage({ type: "activateSession", sessionId: piToolsCurrentId });
    const restored = sessions(last()).find((session) => session.sessionId === piToolsCurrentId);
    expect(restored?.isInactive).toBe(false);
    expect(restored?.state).toBeUndefined();
    expect(last().displayedSessionId).toBe(projectCurrentId);
  });

  it("activates the requested inactive session", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "activateSession", sessionId: projectInactiveId });

    const state = last();
    const active = sessions(state).find((session) => session.sessionId === projectInactiveId);
    expect(active?.isInactive).toBe(false);
    const alreadyOpen = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(alreadyOpen?.isInactive).toBe(false);
  });

  it.each([
    { type: "openSession", sessionId: projectInactiveId },
    { type: "setSessionLock", sessionId: projectCurrentId, locked: true },
  ])("ignores unsupported $type requests", (request) => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage(request);

    expect(states.length).toBe(before);
  });

  it("ignores the removed copySessionId request without using the clipboard", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "copySessionId", sessionId: projectCurrentId });

    expect(writeText).not.toHaveBeenCalled();
    expect(states.length).toBe(before);
  });

  it("resets to the demo states", () => {
    const { reset, last } = setup();

    reset("sample");
    expect(
      sessions(last())
        .filter((session) => session.isInactive)
        .map((session) => session.sessionId),
    ).toEqual([projectInactiveId]);

    reset("empty");
    expect(sessions(last()).every((session) => session.isInactive)).toBe(true);
    expect(sessionIds(last())).toHaveLength(5);
  });

  it("resends the current state on refresh", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "refresh" });

    expect(states.length).toBe(before + 1);
    expect(
      sessions(states.at(-1) as CapturedState).filter((session) => session.isInactive),
    ).toHaveLength(1);
  });

  it("adds an active row to the requested group on newSession", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "newSession", cwd: "~/projects/pi-tools" });

    const added = sessions(last()).find((session) => session.displayName === "New Pi session");
    expect(added?.isInactive).toBe(false);
    const piToolsGroup = last().groups.find((group) => group.cwd === "~/projects/pi-tools");
    expect(piToolsGroup?.sessions.some((session) => session.displayName === "New Pi session")).toBe(
      true,
    );
  });

  it("shows a sessionless group for the registered-only workspace", () => {
    const { postSessions, last } = setup();

    postSessions();

    const registeredOnly = last().groups.find((group) => group.cwd === "~/projects/agenda");
    expect(registeredOnly?.sessions).toEqual([]);
  });

  it("adds a group without sessions on addWorkspace", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "addWorkspace", path: "~/projects/brand-new" });

    const added = last().groups.find((group) => group.cwd === "~/projects/brand-new");
    expect(added?.sessions).toEqual([]);
  });

  it("removes a registered-only group on unregisterWorkspace", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "unregisterWorkspace", cwd: "~/projects/agenda" });

    expect(last().groups.some((group) => group.cwd === "~/projects/agenda")).toBe(false);
  });

  it("removes a group with sessions after unregisterWorkspace", () => {
    const { bridge, last } = setup();
    bridge.postMessage({ type: "addWorkspace", path: "~/projects/vscode-agent-kit" });
    expect(last().groups.some((group) => group.cwd === "~/projects/vscode-agent-kit")).toBe(true);

    bridge.postMessage({ type: "unregisterWorkspace", cwd: "~/projects/vscode-agent-kit" });

    // Registered workspaces are the whitelist: unregistered cwds disappear.
    expect(last().groups.some((group) => group.cwd === "~/projects/vscode-agent-kit")).toBe(false);
  });

  it("does not duplicate a group added twice on addWorkspace", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "addWorkspace", path: "~/projects/brand-new" });
    bridge.postMessage({ type: "addWorkspace", path: "~/projects/brand-new" });

    const groups = last().groups.filter((group) => group.cwd === "~/projects/brand-new");
    expect(groups).toHaveLength(1);
  });
});
