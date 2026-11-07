import { describe, expect, it } from "vitest";
import { cwdLabel, groupSessions } from "../src/grouping";
import type { SessionSummary } from "../src/sessionStore";

function session(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, "sessionId" | "cwd" | "updatedAtMs">,
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
      session({ sessionId: "a", cwd: "/home/user/project-a", updatedAtMs: 1 }),
      session({ sessionId: "b", cwd: "/home/user/project-b", updatedAtMs: 2 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["project-a", "project-b"]);
    expect(groups.map((g) => g.cwd)).toEqual(["/home/user/project-a", "/home/user/project-b"]);
  });

  it("orders groups by label, ascending, case-insensitive", () => {
    const groups = groupSessions([
      session({ sessionId: "z", cwd: "/home/user/Zeta", updatedAtMs: 100 }),
      session({ sessionId: "m", cwd: "/home/user/midway", updatedAtMs: 300 }),
      session({ sessionId: "a", cwd: "/home/user/Alpha", updatedAtMs: 10 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Alpha", "midway", "Zeta"]);
  });

  it("breaks equal labels deterministically (group cwd ascending)", () => {
    const groups = groupSessions([
      session({ sessionId: "s", cwd: "/x/second/name", updatedAtMs: 100 }),
      session({ sessionId: "t", cwd: "/a/first/name", updatedAtMs: 100 }),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(["/a/first/name", "/x/second/name"]);
  });

  it("orders sessions within a group by update time, descending", () => {
    const groups = groupSessions([
      session({ sessionId: "s1", cwd: "/a", updatedAtMs: 300 }),
      session({ sessionId: "s2", cwd: "/a", updatedAtMs: 500 }),
      session({ sessionId: "s3", cwd: "/a", updatedAtMs: 100 }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["s2", "s1", "s3"]);
  });

  it("breaks update-time ties deterministically (session id ascending)", () => {
    const groups = groupSessions([
      session({ sessionId: "b", cwd: "/a", updatedAtMs: 100 }),
      session({ sessionId: "a", cwd: "/a", updatedAtMs: 100 }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("orders unknown timestamps last and breaks unknown ties by session id", () => {
    const groups = groupSessions([
      session({ sessionId: "unknown-b", cwd: "/a", updatedAtMs: null }),
      session({ sessionId: "before-epoch", cwd: "/a", updatedAtMs: -1 }),
      session({ sessionId: "unknown-a", cwd: "/a", updatedAtMs: null }),
      session({ sessionId: "epoch", cwd: "/a", updatedAtMs: 0 }),
    ]);

    expect(groups[0].sessions.map((item) => item.sessionId)).toEqual([
      "epoch",
      "before-epoch",
      "unknown-a",
      "unknown-b",
    ]);
  });

  it("appends a sessionless group for every registered workspace cwd", () => {
    const groups = groupSessions(
      [session({ sessionId: "a", cwd: "/a", updatedAtMs: 1 })],
      ["/registered/empty"],
    );

    expect(groups.map((group) => [group.cwd, group.label, group.sessions])).toEqual([
      ["/a", "a", [expect.objectContaining({ sessionId: "a" })]],
      ["/registered/empty", "empty", []],
    ]);
  });

  it("merges sessionless groups into the label ordering", () => {
    const groups = groupSessions(
      [session({ sessionId: "z", cwd: "/home/user/zebra", updatedAtMs: 1 })],
      ["/home/user/alpha"],
    );

    expect(groups.map((g) => g.label)).toEqual(["alpha", "zebra"]);
  });

  it("merges a registered cwd into its session group by trailing separator", () => {
    const groups = groupSessions(
      [session({ sessionId: "a", cwd: "/a/project", updatedAtMs: 1 })],
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
