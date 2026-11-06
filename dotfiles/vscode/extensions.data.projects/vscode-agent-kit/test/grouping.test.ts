import { describe, expect, it } from "vitest";
import { cwdLabel, groupSessions } from "../src/grouping";
import type { SessionSummary } from "../src/sessionStore";

function session(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, "sessionId" | "cwd" | "mtimeMs">,
): SessionSummary {
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
    expect(groups.map((g) => g.label)).toEqual(["project-a", "project-b"]);
    expect(groups.map((g) => g.cwd)).toEqual(["/home/user/project-a", "/home/user/project-b"]);
  });

  it("orders groups by label, ascending, case-insensitive", () => {
    const groups = groupSessions([
      session({ sessionId: "z", cwd: "/home/user/Zeta", mtimeMs: 100 }),
      session({ sessionId: "m", cwd: "/home/user/midway", mtimeMs: 300 }),
      session({ sessionId: "a", cwd: "/home/user/Alpha", mtimeMs: 10 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Alpha", "midway", "Zeta"]);
  });

  it("breaks equal labels deterministically (group cwd ascending)", () => {
    const groups = groupSessions([
      session({ sessionId: "s", cwd: "/x/second/name", mtimeMs: 100 }),
      session({ sessionId: "t", cwd: "/a/first/name", mtimeMs: 100 }),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(["/a/first/name", "/x/second/name"]);
  });

  it("orders sessions within a group by mtime, descending", () => {
    const groups = groupSessions([
      session({ sessionId: "s1", cwd: "/a", mtimeMs: 300 }),
      session({ sessionId: "s2", cwd: "/a", mtimeMs: 500 }),
      session({ sessionId: "s3", cwd: "/a", mtimeMs: 100 }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["s2", "s1", "s3"]);
  });

  it("breaks mtime ties deterministically (session id ascending)", () => {
    const groups = groupSessions([
      session({ sessionId: "b", cwd: "/a", mtimeMs: 100 }),
      session({ sessionId: "a", cwd: "/a", mtimeMs: 100 }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("appends a sessionless group for every registered workspace cwd", () => {
    const groups = groupSessions(
      [session({ sessionId: "a", cwd: "/a", mtimeMs: 1 })],
      ["/registered/empty"],
    );

    expect(groups.map((group) => [group.cwd, group.label, group.sessions])).toEqual([
      ["/a", "a", [expect.objectContaining({ sessionId: "a" })]],
      ["/registered/empty", "empty", []],
    ]);
  });

  it("merges sessionless groups into the label ordering", () => {
    const groups = groupSessions(
      [session({ sessionId: "z", cwd: "/home/user/zebra", mtimeMs: 1 })],
      ["/home/user/alpha"],
    );

    expect(groups.map((g) => g.label)).toEqual(["alpha", "zebra"]);
  });

  it("merges a registered cwd into its session group by trailing separator", () => {
    const groups = groupSessions(
      [session({ sessionId: "a", cwd: "/a/project", mtimeMs: 1 })],
      ["/a/project/"],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].cwd).toBe("/a/project");
  });

  it("keeps the registered cwd spelling for a group without sessions", () => {
    const groups = groupSessions([], ["/registered/first"]);

    expect(groups.map((group) => group.cwd)).toEqual(["/registered/first"]);
  });
});
