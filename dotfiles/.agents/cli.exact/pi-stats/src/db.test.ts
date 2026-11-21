import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsDb, type SessionRecord, type UsageEventRecord } from "./db";
import { syncStatsDb } from "./main";

const BASE_EPOCH_MS = Date.parse("2026-10-01T00:00:00Z");

let dbs: StatsDb[] = [];
let tempDirs: string[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("StatsDb", () => {
  it("stores and reads back sessions and usage events", () => {
    const db = openMemoryDb();
    const record = makeRecord("/sessions/p/a.jsonl", 1_000, 100);
    const events = [makeEvent("/sessions/p/a.jsonl", 5_000, 10), makeEvent("/sessions/p/a.jsonl", 6_000, 20)];
    db.replaceSession(record, events);
    const tracked = db.getTracked();
    assert.deepEqual(tracked.get("/sessions/p/a.jsonl"), { mtimeMs: 1_000, size: 100 });
    const readBack: UsageEventRecord[] = [];
    db.eachEvent((event) => readBack.push(event));
    assert.equal(readBack.length, 2);
    assert.equal(readBack[0]?.tsMs, 5_000);
    assert.equal(readBack[1]?.tsMs, 6_000);
    const sessions: SessionRecord[] = [];
    db.eachSession((record) => sessions.push(record));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.isSubagent, false);
  });

  it("replaces events when the same session is re-indexed", () => {
    const db = openMemoryDb();
    db.replaceSession(makeRecord("/sessions/p/a.jsonl", 1_000, 100), [makeEvent("/sessions/p/a.jsonl", 5_000, 10)]);
    db.replaceSession(makeRecord("/sessions/p/a.jsonl", 2_000, 120), [makeEvent("/sessions/p/a.jsonl", 7_000, 30)]);
    assert.deepEqual(db.getTracked().get("/sessions/p/a.jsonl"), { mtimeMs: 2_000, size: 120 });
    const readBack: UsageEventRecord[] = [];
    db.eachEvent((event) => readBack.push(event));
    assert.equal(readBack.length, 1);
    assert.equal(readBack[0]?.tsMs, 7_000);
  });

  it("removes sessions and their events", () => {
    const db = openMemoryDb();
    db.replaceSession(makeRecord("/sessions/p/a.jsonl", 1_000, 100), [makeEvent("/sessions/p/a.jsonl", 5_000, 10)]);
    db.removeSessions(["/sessions/p/a.jsonl"]);
    assert.equal(db.getTracked().size, 0);
    let seen = 0;
    db.eachEvent(() => {
      seen += 1;
    });
    assert.equal(seen, 0);
  });
});

describe("syncStatsDb", () => {
  it("indexes new files and skips unchanged files", () => {
    const root = makeTempRoot();
    const db = openMemoryDb();
    writeSessionFile(root, join("--proj--", "a.jsonl"), 10);
    writeSessionFile(root, join("--proj--", "subagents", "b.jsonl"), 20);
    const first = syncStatsDb(db, root);
    assert.equal(first.total, 2);
    assert.equal(first.indexed, 2);
    assert.equal(first.removed, 0);
    const second = syncStatsDb(db, root);
    assert.equal(second.indexed, 0);
    assert.equal(second.removed, 0);
    const subagentSessions: SessionRecord[] = [];
    db.eachSession((record) => {
      if (record.isSubagent) subagentSessions.push(record);
    });
    assert.equal(subagentSessions.length, 1);
    assert.equal(subagentSessions[0]?.project, "--proj--");
  });

  it("re-indexes changed files and drops removed files", () => {
    const root = makeTempRoot();
    const db = openMemoryDb();
    const path = join(root, "--proj--", "a.jsonl");
    writeSessionFile(root, join("--proj--", "a.jsonl"), 10);
    syncStatsDb(db, root);
    writeSessionFile(root, join("--proj--", "a.jsonl"), 10);
    writeSessionFile(root, join("--proj--", "a.jsonl"), 10);
    utimesSync(path, new Date(), new Date(BASE_EPOCH_MS + 60_000));
    const changed = syncStatsDb(db, root);
    assert.equal(changed.indexed, 1);
    rmSync(path);
    const afterRemoval = syncStatsDb(db, root);
    assert.equal(afterRemoval.removed, 1);
    assert.equal(db.getTracked().size, 0);
    let seen = 0;
    db.eachEvent(() => {
      seen += 1;
    });
    assert.equal(seen, 0);
  });
});

function openMemoryDb(): StatsDb {
  const db = new StatsDb(":memory:");
  dbs.push(db);
  return db;
}

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-stats-db-"));
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(root: string, relativePath: string, inputTokens: number): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(BASE_EPOCH_MS).toISOString(), cwd: "/tmp" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: "s",
        timestamp: new Date(BASE_EPOCH_MS + 1_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          provider: "zai",
          model: "glm-5.3-flash",
          usage: { input: inputTokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 1, cost: { total: 0.001 } },
        },
      }),
      "",
    ].join("\n"),
  );
}

function makeRecord(path: string, mtimeMs: number, size: number): SessionRecord {
  return {
    path,
    mtimeMs,
    size,
    project: "--p--",
    sessionId: "abc",
    cwd: "/tmp",
    startedMs: BASE_EPOCH_MS,
    isSubagent: false,
  };
}

function makeEvent(sessionPath: string, tsMs: number, input: number): UsageEventRecord {
  return {
    sessionPath,
    tsMs,
    kind: "message",
    provider: "zai",
    model: "glm-5.3-flash",
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: 0.001,
  };
}
