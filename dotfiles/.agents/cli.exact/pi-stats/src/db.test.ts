import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const events = [
      makeEvent("/sessions/p/a.jsonl", 5_000, 10),
      makeEvent("/sessions/p/a.jsonl", 6_000, 20),
    ];
    db.replaceSessions([{ record, events }]);
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
    const path = "/sessions/p/a.jsonl";
    db.replaceSessions([
      { record: makeRecord(path, 1_000, 100), events: [makeEvent(path, 5_000, 10)] },
    ]);
    db.replaceSessions([
      { record: makeRecord(path, 2_000, 120), events: [makeEvent(path, 7_000, 30)] },
    ]);
    assert.deepEqual(db.getTracked().get(path), { mtimeMs: 2_000, size: 120 });
    const readBack: UsageEventRecord[] = [];
    db.eachEvent((event) => readBack.push(event));
    assert.equal(readBack.length, 1);
    assert.equal(readBack[0]?.tsMs, 7_000);
  });

  it("only passes events in the requested time range to the callback in timestamp order", () => {
    const db = openMemoryDb();
    const path = "/sessions/p/a.jsonl";
    const events = [3_000, 1_000, 4_000, 2_000].map((tsMs) => makeEvent(path, tsMs, 10));
    db.replaceSessions([{ record: makeRecord(path, 1_000, 100), events }]);

    const cases = [
      { fromMs: 2_000, untilMs: 4_000, expected: [2_000, 3_000] },
      { fromMs: 2_000, untilMs: null, expected: [2_000, 3_000, 4_000] },
      { fromMs: null, untilMs: 3_000, expected: [1_000, 2_000] },
      { fromMs: 3_000, untilMs: 3_000, expected: [] },
    ];
    for (const { fromMs, untilMs, expected } of cases) {
      const timestamps: number[] = [];
      db.eachEvent((event) => timestamps.push(event.tsMs), { fromMs, untilMs });
      assert.deepEqual(timestamps, expected, `fromMs=${fromMs}, untilMs=${untilMs}`);
    }
  });

  it("removes sessions and their events", () => {
    const db = openMemoryDb();
    const path = "/sessions/p/a.jsonl";
    db.replaceSessions([
      { record: makeRecord(path, 1_000, 100), events: [makeEvent(path, 5_000, 10)] },
    ]);
    db.removeSessions([path]);
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

  it("rolls back session records and events when a later write in the batch fails", () => {
    const root = makeTempRoot();
    const db = openMemoryDb();
    writeSessionFile(root, join("--proj--", "a.jsonl"), 10);
    writeSessionFile(root, join("--proj--", "b.jsonl"), 20);
    db.db.exec(`
      CREATE TRIGGER reject_second_event BEFORE INSERT ON usage_events
      WHEN EXISTS (SELECT 1 FROM usage_events)
      BEGIN
        SELECT RAISE(ABORT, 'injected usage write failure');
      END;
    `);

    assert.throws(() => syncStatsDb(db, root), /injected usage write failure/);
    assert.equal(db.getTracked().size, 0);
    assert.equal(db.db.query("SELECT * FROM usage_events").get(), null);
  });

  it("re-indexes appended files without duplicating earlier events", () => {
    const root = makeTempRoot();
    const db = openMemoryDb();
    const relativePath = join("--proj--", "a.jsonl");
    writeSessionFile(root, relativePath, 10);
    syncStatsDb(db, root);
    appendFileSync(
      join(root, relativePath),
      `${JSON.stringify(makeUsageEntry("m2", "m1", new Date(BASE_EPOCH_MS + 2_000).toISOString(), 20))}\n`,
    );

    assert.deepEqual(syncStatsDb(db, root), { indexed: 1, removed: 0, total: 1 });
    const inputTokens: number[] = [];
    db.eachEvent((event) => inputTokens.push(event.input));
    assert.deepEqual(inputTokens, [10, 20]);
  });

  it("drops records and events for files removed from the scan", () => {
    const root = makeTempRoot();
    const db = openMemoryDb();
    const relativePath = join("--proj--", "a.jsonl");
    writeSessionFile(root, relativePath, 10);
    syncStatsDb(db, root);
    rmSync(join(root, relativePath));

    assert.deepEqual(syncStatsDb(db, root), { indexed: 0, removed: 1, total: 0 });
    assert.equal(db.getTracked().size, 0);
    assert.equal(db.db.query("SELECT * FROM usage_events").get(), null);
  });
});

it("applies local date boundaries without losing the original start in the top sessions table", () => {
  const home = makeTempRoot();
  const project = join(home, ".pi", "agent", "sessions", "--proj--");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "a.jsonl"),
    [
      { type: "session", id: "s", timestamp: "2025-03-09T04:00:00.000Z" },
      makeUsageEntry("m1", "s", "2025-03-09T04:59:59.999Z", 100),
      makeUsageEntry("m2", "m1", "2025-03-09T05:00:00.000Z", 10),
      makeUsageEntry("m3", "m2", "2025-03-10T03:59:59.999Z", 20),
      makeUsageEntry("m4", "m3", "2025-03-10T04:00:00.000Z", 200),
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join(""),
  );

  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "main.ts"),
      "stats",
      "--since",
      "2025-03-09",
      "--until",
      "2025-03-10",
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        TZ: "America/New_York",
      },
    },
  );

  assert.equal(result.exitCode, 0, result.stderr.toString());
  const output = result.stdout.toString();
  assert.match(output, /^events: 2, span \(event time\): 2025-03-09 \.\. 2025-03-10 \(UTC\)$/m);
  assert.match(output, /^all\s+0\s+2\s+30\s/m);
  assert.match(output, /^2025-03-08 23:00\s+proj\s+zai\/glm-5\.3-flash\s+2\s+32\s/m);
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
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s",
        timestamp: new Date(BASE_EPOCH_MS).toISOString(),
        cwd: "/tmp",
      }),
      JSON.stringify(
        makeUsageEntry("m1", "s", new Date(BASE_EPOCH_MS + 1_000).toISOString(), inputTokens),
      ),
      "",
    ].join("\n"),
  );
}

function makeUsageEntry(id: string, parentId: string, timestamp: string, input: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider: "zai",
      model: "glm-5.3-flash",
      usage: {
        input,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + 1,
        cost: { total: 0.001 },
      },
    },
  };
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
