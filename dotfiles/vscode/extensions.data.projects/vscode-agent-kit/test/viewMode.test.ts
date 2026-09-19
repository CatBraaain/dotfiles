import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/sessionStore";
import { visibleSessions } from "../src/viewMode";

function session(id: string): SessionSummary {
  return {
    sessionId: id,
    filePath: `/sessions/${id}.jsonl`,
    cwd: "/home/user/project",
    displayName: id,
    mtimeMs: 0,
  };
}

describe("visibleSessions", () => {
  const sessions = [session("a"), session("b"), session("c")];

  it("active mode keeps only the sessions marked active, in scan order", () => {
    const visible = visibleSessions(sessions, "active", new Set(["c", "a"]));
    expect(visible.map((s) => s.sessionId)).toEqual(["a", "c"]);
  });

  it("active mode yields an empty list when no session is active", () => {
    expect(visibleSessions(sessions, "active", new Set())).toEqual([]);
  });

  it("active mode ignores active ids that match no listed session", () => {
    const visible = visibleSessions(sessions, "active", new Set(["a", "missing"]));
    expect(visible.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("all mode keeps every session, active or not", () => {
    expect(visibleSessions(sessions, "all", new Set(["a"]))).toEqual(sessions);
  });
});
