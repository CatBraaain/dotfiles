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

  it("sends every session of every group with active marks", () => {
    const groups = sessionViewGroups(sessions, new Set(["active"]));

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/beta", "/workspace/alpha"]);
    expect(groups[0].sessions.map((item) => [item.sessionId, item.isActive])).toEqual([["newest", false]]);
    expect(groups[1].sessions.map((item) => [item.sessionId, item.isActive])).toEqual([
      ["active", true],
      ["older", false],
    ]);
  });

  it("treats unknown sessions as inactive", () => {
    const groups = sessionViewGroups(sessions, new Set());

    expect(groups.every((group) => group.sessions.every((item) => item.isActive === false))).toBe(true);
  });
});
