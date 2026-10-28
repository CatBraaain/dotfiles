import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { canonicalUsageProvider, extractUsageStates } from "./usage";

describe("canonicalUsageProvider", () => {
  it("commandcode を command-code に正規化する", () => {
    assert.equal(canonicalUsageProvider("commandcode"), "command-code");
  });

  it("既知の provider はそのまま", () => {
    assert.equal(canonicalUsageProvider("zai"), "zai");
    assert.equal(canonicalUsageProvider("openai-codex"), "openai-codex");
  });
});

describe("extractUsageStates", () => {
  it("long 枠の残量とリセット時刻を取り出す", () => {
    const states = extractUsageStates([
      {
        provider: "zai",
        short: 88,
        shortResetsAt: "2026-06-17T00:50:00+09:00",
        longWindowMinutes: 10080,
        long: 98,
        longResetsAt: "2026-11-02T14:00:00+09:00",
      },
    ]);
    assert.deepEqual(states?.get("zai"), {
      remaining: 98,
      resetsAt: "2026-11-02T14:00:00+09:00",
      windowMinutes: 10080,
    });
  });

  it("command-code の行は command-code キーで格納する", () => {
    const states = extractUsageStates([
      {
        provider: "command-code",
        short: null,
        shortResetsAt: null,
        long: 100,
        longResetsAt: "2026-11-25T13:03:00+09:00",
      },
    ]);
    assert.ok(states?.has("command-code"));
    assert.ok(!states?.has("commandcode"));
  });

  it("long 不明の行は除外する", () => {
    const states = extractUsageStates([
      {
        provider: "openai-codex",
        short: null,
        shortResetsAt: null,
        long: null,
        longResetsAt: null,
      },
    ]);
    assert.equal(states?.size, 0);
  });

  it("longResetsAt が解析不能な行は除外する", () => {
    const states = extractUsageStates([
      { provider: "zai", short: 1, shortResetsAt: null, long: 50, longResetsAt: "not-a-date" },
    ]);
    assert.equal(states?.size, 0);
  });

  it.each([undefined, null, 0, -1, Infinity, "10080"])(
    "keeps invalid duration facts unknown: %s",
    (longWindowMinutes) => {
      const states = extractUsageStates([
        { provider: "zai", long: 50, longResetsAt: "2026-11-02T14:00:00+09:00", longWindowMinutes },
      ]);
      assert.equal(states?.get("zai")?.windowMinutes, null);
      assert.equal(states?.get("zai")?.remaining, 50);
    },
  );

  it("配列以外は null", () => {
    assert.equal(extractUsageStates({}), null);
    assert.equal(extractUsageStates(null), null);
  });
});
