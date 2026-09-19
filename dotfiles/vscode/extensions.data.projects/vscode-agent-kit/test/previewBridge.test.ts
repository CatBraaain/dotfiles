import { beforeEach, describe, expect, it } from "vitest";

interface CapturedState {
  mode: "active" | "all";
  groups: { cwd: string; sessions: { sessionId: string; isActive: boolean }[] }[];
}

interface PreviewBridgeHandle {
  bridge: {
    postMessage(request: unknown): void;
    onMessage(callback: (message: { type?: string; state?: CapturedState }) => void): void;
  };
  postSessions(): void;
  reset(demoState: string): void;
}

let createPreviewBridge: () => PreviewBridgeHandle;

beforeEach(async () => {
  ({ createPreviewBridge } = await import("../preview/previewBridge.mjs"));
});

function setup() {
  const { bridge, postSessions, reset } = createPreviewBridge();
  const states: CapturedState[] = [];
  bridge.onMessage((message) => {
    if (typeof message === "object" && message !== null && message.type === "sessions" && message.state !== undefined) {
      states.push(message.state);
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

const sampleActiveIds = [
  "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
  "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72",
];
const atlasActiveId = sampleActiveIds[0];
const atlasInactiveId = "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61";

describe("createPreviewBridge", () => {
  it("sends only active sessions in the default active mode", () => {
    const { postSessions, last } = setup();

    postSessions();

    const state = last();
    expect(state.mode).toBe("active");
    expect(sessionIds(state)).toEqual(sampleActiveIds);
    expect(state.groups.every((group) => group.sessions.every((session) => session.isActive))).toBe(true);
  });

  it("shows all sessions with the active mark when mode is set to all", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "setMode", mode: "all" });

    const state = last();
    expect(state.mode).toBe("all");
    expect(sessionIds(state)).toHaveLength(5);
    const marks = state.groups.flatMap((group) => group.sessions.map((session) => session.isActive));
    expect(marks.filter(Boolean)).toHaveLength(2);
  });

  it("removes the row on deactivate in active mode", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "deactivateSession", sessionId: atlasActiveId });

    expect(sessionIds(last())).not.toContain(atlasActiveId);
  });

  it("clears only the active mark on deactivate in all mode", () => {
    const { bridge, last } = setup();

    bridge.postMessage({ type: "setMode", mode: "all" });
    bridge.postMessage({ type: "deactivateSession", sessionId: atlasActiveId });

    const state = last();
    expect(sessionIds(state)).toContain(atlasActiveId);
    const deactivated = state.groups.flatMap((g) => g.sessions).find((s) => s.sessionId === atlasActiveId);
    expect(deactivated?.isActive).toBe(false);
    const stillActive = state.groups.flatMap((g) => g.sessions).find((s) => s.sessionId === sampleActiveIds[1]);
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

    reset("active-empty");
    expect(last().mode).toBe("active");
    expect(last().groups).toEqual([]);

    reset("all-empty");
    expect(last().mode).toBe("all");
    expect(last().groups).toEqual([]);

    reset("sample");
    expect(sessionIds(last())).toEqual(sampleActiveIds);
  });

  it("resends the current state on refresh", () => {
    const { bridge, postSessions, states } = setup();
    postSessions();
    const before = states.length;

    bridge.postMessage({ type: "refresh" });

    expect(states.length).toBe(before + 1);
    expect(sessionIds(states.at(-1) as CapturedState)).toEqual(sampleActiveIds);
  });
});
