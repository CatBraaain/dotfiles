import { describe, expect, it } from "vitest";
import { cwdLabel, groupSessions } from "../src/grouping";
import type { SessionSummary } from "../src/sessionStore";

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "sessionId" | "cwd" | "mtimeMs">): SessionSummary {
  return {
    filePath: `/sessions/x/${overrides.sessionId}.jsonl`,
    displayName: `name-${overrides.sessionId}`,
    ...overrides,
  };
}

describe("cwdLabel", () => {
  it("uses the basename of the cwd", () => {
    expect(cwdLabel("/home/user/project")).toBe("project");
    expect(cwdLabel("/home/user/project/")).toBe("project");
    expect(cwdLabel("project")).toBe("project");
  });

  it("keeps the root path as-is", () => {
    expect(cwdLabel("/")).toBe("/");
  });
});

describe("groupSessions", () => {
  it("returns an empty list for no sessions", () => {
    expect(groupSessions([])).toEqual([]);
  });

  it("groups by cwd with the basename as label", () => {
    const groups = groupSessions([
      session({ sessionId: "a", cwd: "/home/user/project-a", mtimeMs: 1 }),
      session({ sessionId: "b", cwd: "/home/user/project-b", mtimeMs: 2 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["project-b", "project-a"]);
    expect(groups.map((g) => g.cwd)).toEqual(["/home/user/project-b", "/home/user/project-a"]);
  });

  it("orders groups by their newest session mtime, descending", () => {
    const groups = groupSessions([
      session({ sessionId: "old-a", cwd: "/a", mtimeMs: 10 }),
      session({ sessionId: "new-a", cwd: "/a", mtimeMs: 300 }),
      session({ sessionId: "mid-b", cwd: "/b", mtimeMs: 100 }),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(["/a", "/b"]); // /a newest is 300 > /b 100
  });

  it("orders sessions within a group by mtime, descending", () => {
    const groups = groupSessions([
      session({ sessionId: "s1", cwd: "/a", mtimeMs: 300 }),
      session({ sessionId: "s2", cwd: "/a", mtimeMs: 500 }),
      session({ sessionId: "s3", cwd: "/a", mtimeMs: 100 }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["s2", "s1", "s3"]);
  });

  it("breaks mtime ties deterministically (session id, group cwd ascending)", () => {
    const groups = groupSessions([
      session({ sessionId: "b", cwd: "/a", mtimeMs: 100 }),
      session({ sessionId: "a", cwd: "/a", mtimeMs: 100 }),
      session({ sessionId: "z", cwd: "/b", mtimeMs: 100 }),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(["/a", "/b"]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });
});
