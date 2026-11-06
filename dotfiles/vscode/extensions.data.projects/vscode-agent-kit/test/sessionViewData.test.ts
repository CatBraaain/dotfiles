import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/sessionStore";
import { sessionViewGroups } from "../src/webview/sessionViewData";

function session(sessionId: string, cwd: string, mtimeMs: number): SessionSummary {
  return {
    sessionId,
    filePath: `/sessions/${sessionId}.jsonl`,
    cwd,
    displayName: `Session ${sessionId}`,
    mtimeMs,
  };
}

describe("sessionViewGroups", () => {
  const sessions = [
    session("older", "/workspace/alpha", 100),
    session("newest", "/workspace/beta", 300),
    session("active", "/workspace/alpha", 200),
  ];

  it("sends every session of every group with archive and lock marks", () => {
    const groups = sessionViewGroups(sessions, [], new Set(["older"]), new Set(["active"]));

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/alpha", "/workspace/beta"]);
    expect(
      groups[0].sessions.map((item) => [item.sessionId, item.isArchived, item.isLocked]),
    ).toEqual([
      ["active", false, true],
      ["older", true, false],
    ]);
    expect(
      groups[1].sessions.map((item) => [item.sessionId, item.isArchived, item.isLocked]),
    ).toEqual([["newest", false, false]]);
  });

  it("treats sessions without metadata as unarchived and unlocked", () => {
    const groups = sessionViewGroups(sessions, [], new Set(), new Set());

    expect(
      groups.every((group) =>
        group.sessions.every((item) => item.isArchived === false && item.isLocked === false),
      ),
    ).toBe(true);
  });

  it("merges sessionless groups into the label ordering", () => {
    const groups = sessionViewGroups(sessions, ["/workspace/empty"], new Set(), new Set());

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

  it("marks exactly the registered workspace groups", () => {
    const groups = sessionViewGroups(sessions, ["/workspace/alpha"], new Set(), new Set());

    expect(groups.map((group) => [group.cwd, group.registered])).toEqual([
      ["/workspace/alpha", true],
      ["/workspace/beta", false],
    ]);
  });

  it("does not duplicate a registered workspace that already has session groups", () => {
    const groups = sessionViewGroups(sessions, ["/workspace/alpha"], new Set(), new Set());

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/alpha", "/workspace/beta"]);
  });

  it("carries 1000 synthetic sessions as list data", () => {
    const synthetic = Array.from({ length: 1000 }, (_, index) =>
      session(`s-${index}`, `/workspace/ws-${index % 10}`, index),
    );

    const groups = sessionViewGroups(synthetic, [], new Set(["s-0"]), new Set());

    expect(groups).toHaveLength(10);
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(1000);
    expect(groups.at(-1)?.sessions.every((item) => item.isArchived === false)).toBe(true);
  });
});
