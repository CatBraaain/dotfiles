import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  aggregate,
  binLabels,
  collectSessionPairs,
  formatMinutes,
  keysByCountDesc,
  parseAssistantEntry,
  parseBinEdgesMin,
  renderTable,
  type Pair,
  type SessionEntry,
} from "./stats";

const BASE_EPOCH_MS = Date.parse("2026-10-01T00:00:00Z");

describe("collectSessionPairs", () => {
  it("pairs consecutive same-model responses with gap minutes and hit rate", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      assistantEntry("b", "a", { provider: "zai", model: "glm", offsetMinutes: 2, input: 30, cacheRead: 70 }),
    ];
    const { pairs, compactionSkips } = collectSessionPairs(entries, "session-a", undefined);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].gapMinutes, 2);
    assert.equal(pairs[0].hitRate, 0.7);
    assert.equal(pairs[0].session, "session-a");
    assert.equal(compactionSkips, 0);
  });

  it("does not pair across a different-model response", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      assistantEntry("x", "a", { provider: "other", model: "m", offsetMinutes: 1, input: 10, cacheRead: 0 }),
      assistantEntry("b", "x", { provider: "zai", model: "glm", offsetMinutes: 4, input: 10, cacheRead: 10 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 0);
  });

  it("pairs across a filtered-out response when a model pattern is given", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      assistantEntry("x", "a", { provider: "other", model: "m", offsetMinutes: 1, input: 10, cacheRead: 0 }),
      assistantEntry("b", "x", { provider: "zai", model: "glm", offsetMinutes: 4, input: 20, cacheRead: 80 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", "zai");
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].gapMinutes, 4);
  });

  it("counts a same-model pair split by compaction as skipped", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      compactionEntry("c", "a"),
      assistantEntry("b", "c", { provider: "zai", model: "glm", offsetMinutes: 2, input: 10, cacheRead: 10 }),
    ];
    const { pairs, compactionSkips } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 0);
    assert.equal(compactionSkips, 1);
  });

  it("follows parentId and pairs only the active branch", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      assistantEntry("b1", "a", { provider: "zai", model: "glm", offsetMinutes: 5, input: 10, cacheRead: 10 }),
      assistantEntry("b2", "a", { provider: "zai", model: "glm", offsetMinutes: 10, input: 10, cacheRead: 10 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].gapMinutes, 10);
  });

  it("excludes pairs whose gap is negative", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 5, input: 100, cacheRead: 0 }),
      assistantEntry("b", "a", { provider: "zai", model: "glm", offsetMinutes: 0, input: 10, cacheRead: 10 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 0);
  });

  it("excludes pairs whose input and cacheRead are both zero", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      assistantEntry("b", "a", { provider: "zai", model: "glm", offsetMinutes: 2, input: 0, cacheRead: 0 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 0);
  });

  it("ignores entries that are not assistant messages", () => {
    const entries = [
      assistantEntry("a", null, { provider: "zai", model: "glm", offsetMinutes: 0, input: 100, cacheRead: 0 }),
      { id: "u", parentId: "a", type: "message", timestamp: isoMinutes(1), message: { role: "user", content: "hi" } },
      assistantEntry("b", "u", { provider: "zai", model: "glm", offsetMinutes: 2, input: 10, cacheRead: 10 }),
    ];
    const { pairs } = collectSessionPairs(entries, "s", undefined);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].gapMinutes, 2);
  });
});

describe("parseAssistantEntry", () => {
  it("returns null when provider is missing", () => {
    const entry = assistantEntry("a", null, { provider: "", model: "glm", offsetMinutes: 0, input: 1, cacheRead: 1 });
    assert.equal(parseAssistantEntry(entry), null);
  });

  it("returns null when the timestamp is not a date", () => {
    const entry = messageEntry("a", null, { role: "assistant", provider: "zai", model: "glm" }, "not-a-date");
    assert.equal(parseAssistantEntry(entry), null);
  });
});

describe("aggregate and renderTable", () => {
  it("renders per-bin mean hit rates with sample counts", () => {
    const pairs = [makePair("zai", "glm", 0.5, 1), makePair("zai", "glm", 2, 0.5)];
    const table = aggregate(pairs, [1], (pair) => pair.provider);
    const rendered = renderTable(table, [1]);
    assert.match(rendered, /0m-1m/);
    assert.match(rendered, />1m/);
    assert.match(rendered, /100%/);
    assert.match(rendered, /50%/);
  });

  it("renders an empty cell for bins without samples", () => {
    const pairs = [makePair("zai", "glm", 2, 0.5)];
    const table = aggregate(pairs, [1], (pair) => pair.provider);
    const rendered = renderTable(table, [1]);
    assert.doesNotMatch(rendered, /0m-1m.*%/);
  });
});

describe("binLabels", () => {
  it("builds labels from edges with minute and hour units", () => {
    assert.deepEqual(binLabels([1, 60, 180]), ["0m-1m", "1m-1h", "1h-3h", ">3h"]);
  });
});

describe("formatMinutes", () => {
  it("uses minutes below one hour and hours above", () => {
    assert.equal(formatMinutes(30), "30m");
    assert.equal(formatMinutes(60), "1h");
    assert.equal(formatMinutes(180), "3h");
  });
});

describe("parseBinEdgesMin", () => {
  it("returns the default edges when no value is given", () => {
    assert.deepEqual(parseBinEdgesMin(undefined), [1, 5, 15, 30, 60, 180]);
  });

  it("accepts a positive ascending list", () => {
    assert.deepEqual(parseBinEdgesMin("5,30,120"), [5, 30, 120]);
  });

  it("rejects non-ascending edges", () => {
    assert.throws(() => parseBinEdgesMin("5,1"));
  });

  it("rejects non-numeric edges", () => {
    assert.throws(() => parseBinEdgesMin("a,b"));
  });
});

describe("keysByCountDesc", () => {
  it("sorts keys by pair count descending", () => {
    const counts = new Map([
      ["a", 1],
      ["b", 3],
      ["c", 2],
    ]);
    assert.deepEqual(keysByCountDesc(counts), ["b", "c", "a"]);
  });
});

function assistantEntry(
  id: string,
  parentId: string | null,
  options: { provider: string; model: string; offsetMinutes: number; input: number; cacheRead: number },
): SessionEntry {
  return messageEntry(
    id,
    parentId,
    {
      role: "assistant",
      provider: options.provider,
      model: options.model,
      usage: { input: options.input, cacheRead: options.cacheRead },
    },
    isoMinutes(options.offsetMinutes),
  );
}

function compactionEntry(id: string, parentId: string | null): SessionEntry {
  return { id, parentId, type: "compaction", timestamp: isoMinutes(0) };
}

function messageEntry(id: string, parentId: string | null, message: unknown, timestampIso: string): SessionEntry {
  return { id, parentId, type: "message", timestamp: timestampIso, message };
}

function isoMinutes(offsetMinutes: number): string {
  return new Date(BASE_EPOCH_MS + offsetMinutes * 60_000).toISOString();
}

function makePair(provider: string, model: string, gapMinutes: number, hitRate: number): Pair {
  return {
    provider,
    model,
    session: "s",
    timestampIso: "2026-10-01T00:00:00.000Z",
    gapMinutes,
    input: 1,
    cacheRead: 1,
    totalTokens: 2,
    hitRate,
  };
}
