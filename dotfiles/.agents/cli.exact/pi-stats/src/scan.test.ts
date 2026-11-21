import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsageEvents, indexSessionFile, listSessionFiles } from "./scan";
import type { SessionEntry } from "./stats";

const BASE_EPOCH_MS = Date.parse("2026-10-01T00:00:00Z");

describe("collectUsageEvents", () => {
  it("collects assistant message usage along the active chain only", () => {
    const entries = [
      sessionEntry("s1", null, 0),
      assistantEntry("a1", "s1", 1, "zai", "glm-5.3-flash", 100, 10, 500),
      assistantEntry("a2-branch", "s1", 2, "zai", "other", 9_999, 0, 0),
      assistantEntry("a2", "a1", 2, "zai", "glm-5.3-flash", 200, 20, 600),
    ];
    const events = collectUsageEvents(entries, "/sessions/p/file.jsonl");
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.input),
      [100, 200],
    );
    assert.equal(events[0]?.kind, "message");
    assert.equal(events[0]?.provider, "zai");
    assert.equal(events[0]?.model, "glm-5.3-flash");
  });

  it("collects usage-kind and compaction entries with entry-level provider/model", () => {
    const entries = [
      sessionEntry("s1", null, 0),
      {
        type: "usage",
        id: "u1",
        parentId: "s1",
        timestamp: iso(1),
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0, totalTokens: 50_000, cost: { total: 0.015 } },
      } as unknown as SessionEntry,
      {
        type: "compaction",
        id: "c1",
        parentId: "u1",
        timestamp: iso(2),
        usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000, cost: { total: 0.02 } },
      } as unknown as SessionEntry,
    ];
    const events = collectUsageEvents(entries, "/sessions/p/file.jsonl");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "usage");
    assert.equal(events[0]?.provider, "anthropic");
    assert.equal(events[0]?.cacheRead, 50_000);
    assert.equal(events[0]?.cost, 0.015);
    assert.equal(events[1]?.kind, "compaction");
    assert.equal(events[1]?.input, 900);
  });

  it("ignores user messages and entries without usage", () => {
    const entries = [
      sessionEntry("s1", null, 0),
      { type: "message", id: "m1", parentId: "s1", timestamp: iso(1), message: { role: "user", content: "hi" } } as unknown as SessionEntry,
      { type: "message", id: "m2", parentId: "m1", timestamp: iso(2), message: { role: "assistant", content: [{ type: "text", text: "hey" }] } } as unknown as SessionEntry,
    ];
    const events = collectUsageEvents(entries, "/sessions/p/file.jsonl");
    assert.equal(events.length, 0);
  });

  it("skips usage events without a timestamp", () => {
    const entries = [
      sessionEntry("s1", null, 0),
      {
        type: "usage",
        id: "u1",
        parentId: "s1",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude",
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
      } as unknown as SessionEntry,
      assistantEntry("a1", "s1", 2, "zai", "glm", 10, 0, 0),
    ];
    const events = collectUsageEvents(entries, "/sessions/p/file.jsonl");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "message");
  });
});

describe("indexSessionFile", () => {
  it("extracts session id, cwd, start time and events from a session file", () => {
    const dir = makeTempSessionsRoot();
    try {
      const projectDir = join(dir, "--example-project--");
      mkdirSync(projectDir, { recursive: true });
      const path = join(projectDir, "2026-10-01T00-00-00-000Z_abc.jsonl");
      writeFileSync(
        path,
        [
          JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: iso(0), cwd: "/home/user/example" }),
          JSON.stringify(assistantEntry("a1", "abc", 1, "zai", "glm-5.3-flash", 100, 10, 500)),
        ].join("\n"),
      );
      const files = listSessionFiles(dir);
      assert.equal(files.length, 1);
      assert.equal(files[0]?.project, "--example-project--");
      assert.equal(files[0]?.isSubagent, false);
      const indexed = indexSessionFile(files[0]!);
      assert.ok(indexed !== null);
      assert.equal(indexed.record.sessionId, "abc");
      assert.equal(indexed.record.cwd, "/home/user/example");
      assert.equal(indexed.record.startedMs, BASE_EPOCH_MS);
      assert.equal(indexed.record.isSubagent, false);
      assert.equal(indexed.events.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks files under subagents as subagent sessions", () => {
    const dir = makeTempSessionsRoot();
    try {
      const subagentsDir = join(dir, "--example-project--", "subagents");
      mkdirSync(subagentsDir, { recursive: true });
      const path = join(subagentsDir, "child.jsonl");
      writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "child", timestamp: iso(0), cwd: "/tmp" }));
      const files = listSessionFiles(dir);
      assert.equal(files.length, 1);
      assert.equal(files[0]?.isSubagent, true);
      const indexed = indexSessionFile(files[0]!);
      assert.equal(indexed?.record.isSubagent, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for files containing an unparsable line", () => {
    const dir = makeTempSessionsRoot();
    try {
      const projectDir = join(dir, "--example-project--");
      mkdirSync(projectDir, { recursive: true });
      const path = join(projectDir, "broken.jsonl");
      writeFileSync(
        path,
        [JSON.stringify({ type: "session", id: "x", timestamp: iso(0) }), '{"type":"messag', "truncated"].join("\n"),
      );
      const files = listSessionFiles(dir);
      assert.equal(files.length, 1);
      assert.equal(indexSessionFile(files[0]!), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the first entry timestamp when there is no session header", () => {
    const dir = makeTempSessionsRoot();
    try {
      const projectDir = join(dir, "--example-project--");
      mkdirSync(projectDir, { recursive: true });
      const path = join(projectDir, "no-header.jsonl");
      writeFileSync(
        path,
        [JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: iso(5), message: { role: "user", content: "x" } })].join("\n"),
      );
      const files = listSessionFiles(dir);
      const indexed = indexSessionFile(files[0]!);
      assert.equal(indexed?.record.startedMs, BASE_EPOCH_MS + 5_000);
      assert.equal(indexed?.record.sessionId, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeTempSessionsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-stats-scan-"));
}

function sessionEntry(id: string, parentId: string | null, offsetSeconds: number): SessionEntry {
  return { type: "session", version: 3, id, parentId, timestamp: iso(offsetSeconds), cwd: "/home/user" };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  offsetSeconds: number,
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(offsetSeconds),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider,
      model,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output + cacheRead,
        cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0, total: 0.03 },
      },
    },
  };
}

function iso(offsetSeconds: number): string {
  return new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString();
}
