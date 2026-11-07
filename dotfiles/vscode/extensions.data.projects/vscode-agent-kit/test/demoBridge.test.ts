import { describe, expect, it, vi } from "vitest";
import { createDemoBridge, type DemoBridgeRequest, type DemoState } from "../stories/demoBridge";

interface DemoSession {
  sessionId: string;
  displayName: string;
  isArchived: boolean;
  isLocked: boolean;
}

interface CapturedState {
  groups: { cwd: string; registered: boolean; sessions: DemoSession[] }[];
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
const piToolsLockedId = "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83";
const worktreeId = "5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94";

describe("createDemoBridge", () => {
  it("sends every session with archive and lock marks", () => {
    const { postSessions, last } = setup();

    postSessions();

    expect(sessionIds(last())).toHaveLength(5);
    expect(
      sessions(last()).map((session) => [session.sessionId, session.isArchived, session.isLocked]),
    ).toEqual([
      [piToolsCurrentId, false, false],
      [piToolsLockedId, false, true],
      [worktreeId, false, false],
      [projectCurrentId, false, false],
      [projectArchivedId, true, false],
    ]);
  });

  it("archives only the requested sessions and skips locked ones", () => {
    const { bridge, last } = setup();

    bridge.postMessage({
      type: "archiveSessions",
      sessionIds: [projectCurrentId, piToolsLockedId],
    });

    const state = last();
    expect(sessionIds(state)).toContain(projectCurrentId);
    const archived = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(archived?.isArchived).toBe(true);
    const locked = sessions(state).find((session) => session.sessionId === piToolsLockedId);
    expect(locked?.isArchived).toBe(false);
    expect(locked?.isLocked).toBe(true);
    const untouched = sessions(state).find((session) => session.sessionId === piToolsCurrentId);
    expect(untouched?.isArchived).toBe(false);
  });

  it("unarchives only the requested archived sessions", () => {
    const { bridge, last } = setup();

    bridge.postMessage({
      type: "unarchiveSessions",
      sessionIds: [projectArchivedId, projectCurrentId],
    });

    const state = last();
    const unarchived = sessions(state).find((session) => session.sessionId === projectArchivedId);
    expect(unarchived?.isArchived).toBe(false);
    const alreadyOpen = sessions(state).find((session) => session.sessionId === projectCurrentId);
    expect(alreadyOpen?.isArchived).toBe(false);
  });

  it("toggles the lock and unlocks again", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "setSessionLock", sessionId: projectCurrentId, locked: true });
    expect(
      sessions(last()).find((session) => session.sessionId === projectCurrentId)?.isLocked,
    ).toBe(true);

    bridge.postMessage({ type: "setSessionLock", sessionId: projectCurrentId, locked: false });
    expect(
      sessions(last()).find((session) => session.sessionId === projectCurrentId)?.isLocked,
    ).toBe(false);
  });

  it("ignores openSession requests", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "openSession", sessionId: projectArchivedId });

    expect(states.length).toBe(before);
  });

  it("copies the session ID through the clipboard on copySessionId", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "copySessionId", sessionId: projectCurrentId });

    expect(writeText).toHaveBeenCalledWith(projectCurrentId);
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
    expect(added?.isLocked).toBe(false);
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
    bridge.postMessage({ type: "addWorkspace", path: "~/projects/vscode-pi-sessions" });
    expect(last().groups.some((group) => group.cwd === "~/projects/vscode-pi-sessions")).toBe(true);

    bridge.postMessage({ type: "unregisterWorkspace", cwd: "~/projects/vscode-pi-sessions" });

    // Registered workspaces are the whitelist: unregistered cwds disappear.
    expect(last().groups.some((group) => group.cwd === "~/projects/vscode-pi-sessions")).toBe(
      false,
    );
  });

  it("does not duplicate a group added twice on addWorkspace", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "addWorkspace", path: "~/projects/brand-new" });
    bridge.postMessage({ type: "addWorkspace", path: "~/projects/brand-new" });

    const groups = last().groups.filter((group) => group.cwd === "~/projects/brand-new");
    expect(groups).toHaveLength(1);
  });
});
