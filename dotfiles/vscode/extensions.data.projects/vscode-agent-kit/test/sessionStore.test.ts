import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { appendFile, readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { listSessions, sessionFileExists } from "../src/sessionStore";
import { groupSessions } from "../src/grouping";
import { cleanup, header, messageEntry, sessionInfoEntry, tempDir, writeJsonl } from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await tempDir("pi-session-store-test-");
});

afterEach(async () => {
  await cleanup(root);
});

function groupDir(name: string): string {
  return join(root, name);
}

describe("sessionFileExists", () => {
  it("returns true only for an existing regular file", async () => {
    const filePath = await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [header()]);

    await expect(sessionFileExists(filePath)).resolves.toBe(true);
    await expect(sessionFileExists(groupDir("--home-a--"))).resolves.toBe(false);
    await expect(sessionFileExists(join(root, "missing.jsonl"))).resolves.toBe(false);
  });
});

describe("listSessions", () => {
  it("returns an empty list when the session directory does not exist", async () => {
    expect(await listSessions(join(root, "missing"))).toEqual([]);
  });

  it("lists sessions from every cwd group directory", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    await writeJsonl(groupDir("--home-b--"), "t2_id2.jsonl", [
      header({ id: "id2", cwd: "/home/b" }),
    ]);
    const sessions = await listSessions(root);
    expect(new Set(sessions.map((s) => s.sessionId))).toEqual(new Set(["id1", "id2"]));
  });

  it("takes session id and cwd from the header, not from the directory name", async () => {
    await writeJsonl(groupDir("--totally-different--"), "t1_real-id.jsonl", [
      header({ id: "real-id", cwd: "/elsewhere/project" }),
    ]);
    const sessions = await listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("real-id");
    expect(sessions[0].cwd).toBe("/elsewhere/project");
    expect(sessions[0].filePath).toBe(join(groupDir("--totally-different--"), "t1_real-id.jsonl"));
  });

  it("ignores non-jsonl files and jsonl files outside a cwd group", async () => {
    await writeJsonl(groupDir("--home-a--"), "notes.txt", [header({ id: "x" })]);
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    await writeJsonl(root, "loose.jsonl", [header({ id: "loose", cwd: "/home/a" })]);
    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.sessionId)).toEqual(["id1"]);
  });

  it("does not recurse: nested directories and subagents/ are excluded", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    await writeJsonl(groupDir("--home-a--/subagents"), "t2_sub.jsonl", [
      header({ id: "sub", cwd: "/home/a" }),
    ]);
    await writeJsonl(groupDir("--home-a--/nested"), "t3_deep.jsonl", [
      header({ id: "deep", cwd: "/home/a" }),
    ]);
    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.sessionId)).toEqual(["id1"]);
  });

  it("ignores a root-level subagents directory", async () => {
    await writeJsonl(join(root, "subagents"), "t4_root-sub.jsonl", [
      header({ id: "root-sub", cwd: "/home/a" }),
    ]);
    expect(await listSessions(root)).toEqual([]);
  });

  it("skips files whose first line is not a valid session header", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_bad.jsonl", [messageEntry("user", "hi")]);
    await writeJsonl(groupDir("--home-a--"), "t2_empty.jsonl", []);
    await writeJsonl(groupDir("--home-a--"), "t3_good.jsonl", [
      header({ id: "good", cwd: "/home/a" }),
    ]);
    const sessions = await listSessions(root);
    expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
  });

  it("keeps start-time ordering and update times when only mtime changes", async () => {
    const olderStart = "2024-12-03T14:00:00.000Z";
    const newerStart = "2024-12-04T14:00:00.000Z";
    const olderActivity = "2024-12-06T14:00:00.000Z";
    const newerActivity = "2024-12-05T14:00:00.000Z";
    const olderPath = await writeJsonl(groupDir("--home-a--"), "older.jsonl", [
      header({ id: "older", cwd: "/home/a", timestamp: olderStart }),
      messageEntry("user", "older", { timestamp: olderActivity }),
    ]);
    const newerPath = await writeJsonl(groupDir("--home-a--"), "newer.jsonl", [
      header({ id: "newer", cwd: "/home/a", timestamp: newerStart }),
      messageEntry("assistant", [], { timestamp: newerActivity }),
    ]);
    await utimes(olderPath, 1_700_000_100, 1_700_000_100);
    await utimes(newerPath, 1_700_000_000, 1_700_000_000);
    const expected = [
      ["newer", Date.parse(newerStart), Date.parse(newerActivity)],
      ["older", Date.parse(olderStart), Date.parse(olderActivity)],
    ];
    const before = groupSessions(await listSessions(root))[0].sessions;
    expect(
      before.map((session) => [session.sessionId, session.createdAtMs, session.updatedAtMs]),
    ).toEqual(expected);

    await utimes(olderPath, 1_800_000_000, 1_800_000_000);

    const after = groupSessions(await listSessions(root))[0].sessions;
    expect(
      after.map((session) => [session.sessionId, session.createdAtMs, session.updatedAtMs]),
    ).toEqual(expected);
  });

  it.each([
    "thinking_level_change",
    "model_change",
    "session_info",
    "custom",
    "custom_message",
    "branch_summary",
  ])("keeps update times and ordering after appending %s metadata", async (type) => {
    const timestamp = "2024-12-04T14:00:00.000Z";
    const filePath = await writeJsonl(groupDir("--home-a--"), "older.jsonl", [
      header({ id: "older", cwd: "/home/a" }),
      messageEntry("user", "older", { timestamp }),
    ]);
    await writeJsonl(groupDir("--home-a--"), "newer.jsonl", [
      header({ id: "newer", cwd: "/home/a", timestamp: "2024-12-05T14:00:00.000Z" }),
    ]);
    const before = groupSessions(await listSessions(root))[0].sessions.map((session) => [
      session.sessionId,
      session.updatedAtMs,
    ]);
    expect(before).toEqual([
      ["newer", Date.parse("2024-12-05T14:00:00.000Z")],
      ["older", Date.parse(timestamp)],
    ]);

    await appendFile(
      filePath,
      JSON.stringify({ type, name: "Renamed", timestamp: "2030-01-01T00:00:00.000Z" }) + "\n",
    );

    const after = groupSessions(await listSessions(root))[0].sessions.map((session) => [
      session.sessionId,
      session.updatedAtMs,
    ]);
    expect(after).toEqual(before);
  });

  it.each(["message", "compaction"])(
    "refreshes update time without reordering after appending %s activity",
    async (type) => {
      const olderStart = "2024-12-03T14:00:00.000Z";
      const newerStart = "2024-12-04T14:00:00.000Z";
      const filePath = await writeJsonl(groupDir("--home-a--"), "cached.jsonl", [
        header({ id: "cached", cwd: "/home/a", timestamp: olderStart }),
      ]);
      await writeJsonl(groupDir("--home-a--"), "newer.jsonl", [
        header({ id: "newer", cwd: "/home/a", timestamp: newerStart }),
      ]);
      const before = groupSessions(await listSessions(root))[0].sessions;
      expect(before.map((session) => [session.sessionId, session.updatedAtMs])).toEqual([
        ["newer", Date.parse(newerStart)],
        ["cached", Date.parse(olderStart)],
      ]);
      const { atime, mtime } = await stat(filePath);
      const timestamp = "2024-12-05T14:00:00.000Z";

      await appendFile(
        filePath,
        JSON.stringify(messageEntry("toolResult", [], { type, timestamp })) + "\n",
      );
      await utimes(filePath, atime, mtime);

      const after = groupSessions(await listSessions(root))[0].sessions;
      expect(
        after.map((session) => [session.sessionId, session.createdAtMs, session.updatedAtMs]),
      ).toEqual([
        ["newer", Date.parse(newerStart), Date.parse(newerStart)],
        ["cached", Date.parse(olderStart), Date.parse(timestamp)],
      ]);
      const refreshed = groupSessions(await listSessions(root))[0].sessions;
      expect(refreshed).toEqual(after);
    },
  );

  it("keeps sessions with unknown timestamps in the list", async () => {
    await writeJsonl(groupDir("--home-a--"), "unknown.jsonl", [
      header({ id: "unknown", cwd: "/home/a", timestamp: undefined }),
      messageEntry("user", "No valid date", { timestamp: "invalid" }),
    ]);

    expect(await listSessions(root)).toMatchObject([
      { sessionId: "unknown", displayName: "No valid date", createdAtMs: null, updatedAtMs: null },
    ]);
  });

  it("keeps unknown start times last despite newer activity", async () => {
    await writeJsonl(groupDir("--home-a--"), "unknown-b.jsonl", [
      header({ id: "unknown-b", cwd: "/home/a", timestamp: "invalid" }),
      messageEntry("user", "Recent activity", { timestamp: "2031-01-01T00:00:00.000Z" }),
    ]);
    await writeJsonl(groupDir("--home-a--"), "epoch.jsonl", [
      header({ id: "epoch", cwd: "/home/a", timestamp: "1970-01-01T00:00:00.000Z" }),
    ]);
    await writeJsonl(groupDir("--home-a--"), "unknown-a.jsonl", [
      header({ id: "unknown-a", cwd: "/home/a", timestamp: undefined }),
      messageEntry("assistant", [], { timestamp: "2030-01-01T00:00:00.000Z" }),
    ]);

    const sessions = groupSessions(await listSessions(root))[0].sessions;
    expect(sessions.map((session) => [session.sessionId, session.createdAtMs])).toEqual([
      ["epoch", 0],
      ["unknown-a", null],
      ["unknown-b", null],
    ]);
  });

  it("resolves the display name through the session_info rule", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
      messageEntry("user", "first message"),
      sessionInfoEntry("Named session"),
    ]);
    const sessions = await listSessions(root);
    expect(sessions[0].displayName).toBe("Named session");
  });

  it("re-reads a session file after it changes (summary cache invalidation)", async () => {
    const dir = groupDir("--home-a--");
    await writeJsonl(dir, "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
      messageEntry("user", "first"),
    ]);
    expect((await listSessions(root))[0].displayName).toBe("first");
    // pi appends to the file; size and mtime change, so the cached summary must be invalidated
    await writeJsonl(dir, "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
      messageEntry("user", "first"),
      sessionInfoEntry("Renamed"),
    ]);
    expect((await listSessions(root))[0].displayName).toBe("Renamed");
  });

  it("does not modify session files while listing (read-only access)", async () => {
    const filePath = await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    const before = await readFile(filePath);
    await listSessions(root);
    const after = await readFile(filePath);
    expect(after.equals(before)).toBe(true);
  });

  it("propagates an error instead of returning an empty list when reading the session directory fails", async () => {
    const dir = groupDir("--home-a--");
    await writeJsonl(dir, "t1_id1.jsonl", [header({ id: "id1", cwd: "/home/a" })]);
    // a permission error (EACCES) must not be swallowed like a missing directory (ENOENT)
    chmodSync(dir, 0o000);
    try {
      await expect(listSessions(root)).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe("listSessions scoped scans", () => {
  it("scans only the cwd groups the given workspace cwds map to", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    await writeJsonl(groupDir("--home-b--"), "t2_id2.jsonl", [
      header({ id: "id2", cwd: "/home/b" }),
    ]);
    const sessions = await listSessions(root, { cwds: ["/home/b"] });
    expect(sessions.map((s) => s.sessionId)).toEqual(["id2"]);
  });

  it("returns an empty list for an empty cwd list", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    expect(await listSessions(root, { cwds: [] })).toEqual([]);
  });

  it("still lists all groups after a scoped scan kept other groups in the cache", async () => {
    await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    await writeJsonl(groupDir("--home-b--"), "t2_id2.jsonl", [
      header({ id: "id2", cwd: "/home/b" }),
    ]);
    expect((await listSessions(root, { cwds: ["/home/b"] })).map((s) => s.sessionId)).toEqual([
      "id2",
    ]);
    expect((await listSessions(root)).map((s) => s.sessionId)).toEqual(["id1", "id2"]);
  });
});
