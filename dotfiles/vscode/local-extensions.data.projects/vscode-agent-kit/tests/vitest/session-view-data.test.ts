import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../src/session-store";
import { sessionViewGroups } from "../../src/webview/session-view-data";

function session(
  sessionId: string,
  cwd: string,
  createdAtMs: number | null,
  updatedAtMs = createdAtMs,
): SessionSummary {
  return {
    sessionId,
    filePath: `/sessions/${sessionId}.jsonl`,
    cwd,
    displayName: `Session ${sessionId}`,
    createdAtMs,
    updatedAtMs,
  };
}

describe("sessionViewGroups", () => {
  const sessions = [
    session("older", "/workspace/alpha", 100),
    session("newest", "/workspace/beta", 300),
    session("active", "/workspace/alpha", 200),
  ];
  const registered = ["/workspace/alpha", "/workspace/beta"];
  const view = (overrides: Partial<Parameters<typeof sessionViewGroups>[1]> = {}) => ({
    registeredCwds: registered,
    inactiveIds: new Set<string>(),
    phases: new Map<string, "running" | "waiting-approval" | "waiting-user">(),
    ...overrides,
  });

  it("sends every session of every registered group with deactivate marks", () => {
    const groups = sessionViewGroups(sessions, view({ inactiveIds: new Set(["older"]) }));

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/alpha", "/workspace/beta"]);
    expect(groups[0].sessions.map((item) => [item.sessionId, item.isInactive])).toEqual([
      ["active", false],
      ["older", true],
    ]);
    expect(groups[1].sessions.map((item) => [item.sessionId, item.isInactive])).toEqual([
      ["newest", false],
    ]);
  });

  it("carries update times independently from start-time sorting, including unknown dates", () => {
    const groups = sessionViewGroups(
      [
        session("unknown-start", "/workspace/alpha", null, 300),
        session("undated", "/workspace/alpha", null),
        session("older", "/workspace/alpha", 100, 500),
        session("newer", "/workspace/alpha", 200, 100),
      ],
      view(),
    );

    expect(groups[0].sessions.map((item) => [item.sessionId, item.updatedAtMs])).toEqual([
      ["newer", 100],
      ["older", 500],
      ["undated", null],
      ["unknown-start", 300],
    ]);
  });

  it("treats sessions without metadata as active", () => {
    const groups = sessionViewGroups(sessions, view());

    expect(groups.every((group) => group.sessions.every((item) => item.isInactive === false))).toBe(
      true,
    );
  });

  it("merges sessionless groups into the label ordering", () => {
    const groups = sessionViewGroups(
      sessions,
      view({ registeredCwds: [...registered, "/workspace/empty"] }),
    );

    expect(groups.map((group) => [group.cwd, group.sessions])).toEqual([
      [
        "/workspace/alpha",
        [
          expect.objectContaining({ sessionId: "active" }),
          expect.objectContaining({ sessionId: "older" }),
        ],
      ],
      ["/workspace/beta", [expect.objectContaining({ sessionId: "newest" })]],
      ["/workspace/empty", []],
    ]);
    expect(groups[2].label).toBe("empty");
  });

  it("drops the groups of workspaces that are not registered", () => {
    const groups = sessionViewGroups(sessions, view({ registeredCwds: ["/workspace/alpha"] }));

    // The list is a whitelist: /workspace/beta has a session but no registration.
    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/alpha"]);
  });

  it("does not duplicate a registered workspace that already has session groups", () => {
    const groups = sessionViewGroups(sessions, view({ registeredCwds: ["/workspace/alpha"] }));

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/alpha"]);
  });

  it("marks live sessions independently from the inactive state and phase", () => {
    const groups = sessionViewGroups(
      sessions,
      view({ inactiveIds: new Set(["older", "newest"]), liveIds: new Set(["older", "active"]) }),
    );

    expect(
      groups.flatMap((group) => group.sessions).map((row) => [row.sessionId, row.isLive]),
    ).toEqual([
      ["active", true],
      ["older", true],
      ["newest", undefined],
    ]);
  });

  it("carries the live phase of sessions that have one", () => {
    const groups = sessionViewGroups(sessions, view({ phases: new Map([["active", "running"]]) }));

    expect(
      groups.flatMap((group) => group.sessions).map((item) => [item.sessionId, item.state]),
    ).toEqual([
      ["active", "running"],
      ["older", undefined],
      ["newest", undefined],
    ]);
  });

  it("carries the publish-delayed flag independently from the phase", () => {
    const groups = sessionViewGroups(sessions, view({ delayedIds: new Set(["active", "newest"]) }));

    expect(
      groups
        .flatMap((group) => group.sessions)
        .map((item) => [item.sessionId, item.publishDelayed]),
    ).toEqual([
      ["active", true],
      ["older", false],
      ["newest", true],
    ]);
  });

  it("carries unread independently from the execution phase", () => {
    const groups = sessionViewGroups(
      sessions,
      view({
        phases: new Map([
          ["active", "waiting-user"],
          ["older", "waiting-user"],
        ]),
        unreadIds: new Set(["active"]),
      }),
    );

    expect(
      groups
        .flatMap((group) => group.sessions)
        .map((item) => [item.sessionId, item.state, item.hasUnread]),
    ).toEqual([
      ["active", "waiting-user", true],
      ["older", "waiting-user", false],
      ["newest", undefined, false],
    ]);
  });

  it("carries 1000 synthetic sessions as list data", () => {
    const synthetic = Array.from({ length: 1000 }, (_, index) =>
      session(`s-${index}`, `/workspace/ws-${index % 10}`, index),
    );
    const syntheticCwds = Array.from({ length: 10 }, (_, index) => `/workspace/ws-${index}`);

    const groups = sessionViewGroups(
      synthetic,
      view({ registeredCwds: syntheticCwds, inactiveIds: new Set(["s-0"]) }),
    );

    expect(groups).toHaveLength(10);
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(1000);
    expect(groups.at(-1)?.sessions.every((item) => item.isInactive === false)).toBe(true);
  });
});
