import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import { readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { listSessions, sessionFileExists } from "../src/sessionStore";
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

  it("uses the file mtime as the updated time", async () => {
    const filePath = await writeJsonl(groupDir("--home-a--"), "t1_id1.jsonl", [
      header({ id: "id1", cwd: "/home/a" }),
    ]);
    const mtime = new Date(1_700_000_000_000);
    await utimes(filePath, mtime, mtime);
    const sessions = await listSessions(root);
    expect(sessions[0].mtimeMs).toBe(1_700_000_000_000);
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
