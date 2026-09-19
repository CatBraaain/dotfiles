import { describe, expect, it } from "vitest";
import { createDemoBridge, type DemoBridgeRequest, type DemoState } from "../stories/demoBridge";

interface CapturedState {
  groups: { cwd: string; sessions: { sessionId: string; displayName: string; isActive: boolean }[] }[];
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

function sessionIds(state: CapturedState): string[] {
  return state.groups.flatMap((group) => group.sessions.map((session) => session.sessionId));
}

function activeSessions(state: CapturedState): { sessionId: string; isActive: boolean }[] {
  return state.groups.flatMap((group) => group.sessions).filter((session) => session.isActive);
}

const sampleActiveIds = [
  "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
  "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72",
];
const atlasActiveId = sampleActiveIds[0];
const atlasInactiveId = "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61";

describe("createDemoBridge", () => {
  it("sends every session with active marks", () => {
    const { postSessions, last } = setup();

    postSessions();

    const state = last();
    expect(sessionIds(state)).toHaveLength(5);
    expect(activeSessions(state).map((session) => session.sessionId)).toEqual(sampleActiveIds);
  });

  it("clears only the active mark on archive", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "archiveSession", sessionId: atlasActiveId });

    const state = last();
    expect(sessionIds(state)).toContain(atlasActiveId);
    const archived = state.groups.flatMap((group) => group.sessions).find((session) => session.sessionId === atlasActiveId);
    expect(archived?.isActive).toBe(false);
    const stillActive = state.groups
      .flatMap((group) => group.sessions)
      .find((session) => session.sessionId === sampleActiveIds[1]);
    expect(stillActive?.isActive).toBe(true);
  });

  it("ignores openSession requests", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "openSession", sessionId: atlasInactiveId });

    expect(states.length).toBe(before);
  });

  it("resets to the demo states", () => {
    const { reset, last } = setup();

    reset("sample");
    expect(activeSessions(last()).map((session) => session.sessionId)).toEqual(sampleActiveIds);

    reset("empty");
    expect(activeSessions(last())).toEqual([]);
    expect(sessionIds(last())).toHaveLength(5);
  });

  it("resends the current state on refresh", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "refresh" });

    expect(states.length).toBe(before + 1);
    expect(activeSessions(states.at(-1) as CapturedState).map((session) => session.sessionId)).toEqual(sampleActiveIds);
  });

  it("adds an active row on newSession", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "newSession" });

    const rows = last().groups.flatMap((group) => group.sessions);
    expect(rows.filter((session) => session.isActive)).toHaveLength(3);
    const added = rows.find((session) => session.displayName === "New Pi session");
    expect(added?.isActive).toBe(true);
  });
});
