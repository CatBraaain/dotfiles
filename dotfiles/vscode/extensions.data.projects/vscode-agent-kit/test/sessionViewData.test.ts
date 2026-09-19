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

  it("shows only active sessions in active mode", () => {
    const groups = sessionViewGroups(sessions, "active", new Set(["active"]));

    expect(groups).toEqual([
      {
        cwd: "/workspace/alpha",
        label: "alpha",
        sessions: [
          {
            sessionId: "active",
            displayName: "Session active",
            mtimeMs: 200,
            isActive: true,
          },
        ],
      },
    ]);
  });

  it("keeps inactive sessions and active markers in all mode", () => {
    const groups = sessionViewGroups(sessions, "all", new Set(["active"]));

    expect(groups.map((group) => group.cwd)).toEqual(["/workspace/beta", "/workspace/alpha"]);
    expect(groups[1].sessions.map((item) => [item.sessionId, item.isActive])).toEqual([
      ["active", true],
      ["older", false],
    ]);
  });
});
