import { describe, expect, it, vi } from "vitest";
import { createDemoBridge, type DemoBridgeRequest, type DemoState } from "../stories/demoBridge";

interface DemoSession {
  sessionId: string;
  displayName: string;
  isArchived: boolean;
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
const projectArchivedId = "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61";
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
  it("sends every session with archive marks and the displayed session", () => {
    const { postSessions, last } = setup();

    postSessions();

    expect(sessionIds(last())).toHaveLength(5);
    expect(sessions(last()).map((session) => [session.sessionId, session.isArchived])).toEqual([
      [piToolsCurrentId, false],
      [piToolsOtherId, false],
      [worktreeId, false],
      [projectCurrentId, false],
      [projectArchivedId, true],
    ]);
    expect(last().displayedSessionId).toBe(projectCurrentId);
  });

  it("archives the requested session", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "archiveSession", sessionId: projectCurrentId });
    const state = last();
    expect(sessionIds(state)).toContain(projectCurrentId);
    const archived = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(archived?.isArchived).toBe(true);
    expect(archived?.state).toBeUndefined();
    expect(state.displayedSessionId).toBeUndefined();
    const untouched = sessions(state).find((session) => session.sessionId === piToolsCurrentId);
    expect(untouched?.isArchived).toBe(false);
  });

  it("finishes archive and unarchive requests with their request ids", () => {
    const demo = createDemoBridge();
    const finished: { type?: string; requestId?: string }[] = [];
    demo.bridge.onMessage((message) => {
      const completion = message as { type?: string; requestId?: string };
      if (completion.type === "archiveFinished" || completion.type === "unarchiveFinished")
        finished.push(completion);
    });
    demo.bridge.postMessage({
      type: "archiveSession",
      sessionId: projectCurrentId,
      requestId: "archive-request",
    });
    demo.bridge.postMessage({
      type: "unarchiveSession",
      sessionId: projectArchivedId,
      requestId: "unarchive-request",
    });
    expect(finished).toEqual([
      { type: "archiveFinished", requestId: "archive-request" },
      { type: "unarchiveFinished", requestId: "unarchive-request" },
    ]);
    demo.bridge.postMessage({ type: "archiveSession", sessionId: piToolsCurrentId });
    expect(finished).toHaveLength(2);
  });

  it("clears selection when archiving the displayed session even with an unarchived same-cwd row", () => {
    const { bridge, last } = setup();
    bridge.postMessage({ type: "unarchiveSession", sessionId: projectArchivedId });
    bridge.postMessage({ type: "archiveSession", sessionId: projectCurrentId });
    expect(last().displayedSessionId).toBeUndefined();
    expect(
      sessions(last()).find((session) => session.sessionId === projectCurrentId)?.isArchived,
    ).toBe(true);
    expect(
      sessions(last()).find((session) => session.sessionId === projectArchivedId)?.isArchived,
    ).toBe(false);
  });

  it("keeps another displayed session when archiving and never restores a stopped phase", () => {
    const { bridge, last } = setup();
    bridge.postMessage({ type: "archiveSession", sessionId: piToolsCurrentId });
    expect(last().displayedSessionId).toBe(projectCurrentId);
    bridge.postMessage({ type: "unarchiveSession", sessionId: piToolsCurrentId });
    const restored = sessions(last()).find((session) => session.sessionId === piToolsCurrentId);
    expect(restored?.isArchived).toBe(false);
    expect(restored?.state).toBeUndefined();
    expect(last().displayedSessionId).toBe(projectCurrentId);
  });

  it("unarchives the requested archived session", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "unarchiveSession", sessionId: projectArchivedId });

    const state = last();
    const unarchived = sessions(state).find((session) => session.sessionId === projectArchivedId);
    expect(unarchived?.isArchived).toBe(false);
    const alreadyOpen = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(alreadyOpen?.isArchived).toBe(false);
  });

  it.each([
    { type: "openSession", sessionId: projectArchivedId },
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
        .filter((session) => session.isArchived)
        .map((session) => session.sessionId),
    ).toEqual([projectArchivedId]);

    reset("empty");
    expect(sessions(last()).every((session) => session.isArchived)).toBe(true);
    expect(sessionIds(last())).toHaveLength(5);
  });

  it("resends the current state on refresh", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "refresh" });

    expect(states.length).toBe(before + 1);
    expect(
      sessions(states.at(-1) as CapturedState).filter((session) => session.isArchived),
    ).toHaveLength(1);
  });

  it("adds an unarchived row to the requested group on newSession", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "newSession", cwd: "~/projects/pi-tools" });

    const added = sessions(last()).find((session) => session.displayName === "New Pi session");
    expect(added?.isArchived).toBe(false);
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
