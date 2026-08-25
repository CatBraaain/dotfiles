// 実行: bun --install=auto run routing.test.ts
//
// `when` は冪等なフェイクコマンド（echo 1=有効 / exit 1=無効）で駆動する。

import assert from "node:assert/strict";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import {
  bashExecFrom,
  evalWhen,
  isCoolingDown,
  isManualSelect,
  isRateLimitedError,
  parseRetryAfter,
  pickCandidate,
  recordCooldown,
  type ModelCandidate,
} from "./routing";

// ponytail: 自作ランナー（vitest は bun auto-install 非互換のため逐次実行）。
const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";
function describe(name: string, fn: () => void): void {
  const prev = group;
  group = name;
  fn();
  group = prev;
}
function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

type ModelFound = { provider: string; id: string };

const bashExec = bashExecFrom(createLocalBashOperations());
const runWhen = (when: string | undefined) => evalWhen(when, bashExec, 1000);

const findIn =
  (available: ModelFound[]) =>
  (provider: string, id: string): ModelFound | undefined =>
    available.find((m) => m.provider === provider && m.id === id);

const exitZeroCommand = "echo 1";
const exitOneCommand = "exit 1";

const availableModels: ModelFound[] = [
  { provider: "zai", id: "glm-5.2" },
  { provider: "zai", id: "glm-5.1" },
  { provider: "zai", id: "free" },
  { provider: "zai", id: "x" },
];

const route = (
  candidates: ModelCandidate[],
  {
    available = availableModels,
    cooldowns = new Map<string, number>(),
  }: {
    available?: ModelFound[];
    cooldowns?: Map<string, number>;
  } = {},
): Promise<ModelFound | null> =>
  pickCandidate(candidates, cooldowns, findIn(available), runWhen, 0);

describe("tier の候補選択", () => {
  it("when が通る候補を採用する", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2", when: exitZeroCommand },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel?.id, "glm-5.2");
  });

  it("when が外れた候補は次候補へフォールスルーする", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2", when: exitOneCommand },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel?.id, "glm-5.1");
  });

  it("when の空文字は常に有効になる", async () => {
    const isAvailable = await evalWhen(
      "   ",
      async () => {
        throw new Error("must not execute");
      },
      5000,
    );
    assert.equal(isAvailable, true);
  });

  it("when のタイムアウトは候補を無効にする", async () => {
    const isAvailable = await evalWhen(
      "sleep 10",
      async (_command, options) => {
        assert.equal(options.timeout, 5000);
        throw new Error("timed out");
      },
      5000,
    );
    assert.equal(isAvailable, false);
  });

  it("when の実行失敗は候補を無効にする", async () => {
    const isAvailable = await evalWhen(
      "broken command",
      async () => {
        throw new Error("spawn failed");
      },
      5000,
    );
    assert.equal(isAvailable, false);
  });

  it("when 無しは常に候補になる", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "free" },
      { provider: "zai", model: "paid" },
    ];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel?.id, "free");
  });

  it("モデルレジストリに無いものは when に関わらず飛ばす", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "ghost", when: exitZeroCommand },
      { provider: "zai", model: "real", when: exitZeroCommand },
    ];
    const availables = [{ provider: "zai", id: "real" }];
    const selectedModel = await route(candidates, { available: availables });
    assert.strictEqual(selectedModel?.id, "real");
  });

  it("全候補が不成立なら null を返す", async () => {
    const candidates: ModelCandidate[] = [{ provider: "zai", model: "x", when: exitOneCommand }];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel, null);
  });
});

describe("cooldown", () => {
  it("冷却中の候補を飛ばして次候補を採用する", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const glm52InCooldown = new Map<string, number>();
    recordCooldown(glm52InCooldown, "zai/glm-5.2", 60_000, 0);

    const selectedModel = await route(candidates, { cooldowns: glm52InCooldown });
    assert.strictEqual(selectedModel?.id, "glm-5.1");
  });

  it("期限内は冷却中と判定する", () => {
    const cooldowns = new Map<string, number>();
    const now = 1000;
    recordCooldown(cooldowns, "zai/glm-5.2", 30_000, now);

    const stillCooling = isCoolingDown("zai/glm-5.2", cooldowns, now);
    assert.strictEqual(stillCooling, true);
  });

  it("期限後は冷却を解除し、エントリを削除する", () => {
    const cooldowns = new Map<string, number>();
    const now = 1000;
    const durationMs = 30_000;
    recordCooldown(cooldowns, "zai/glm-5.2", durationMs, now);

    const released = isCoolingDown("zai/glm-5.2", cooldowns, now + durationMs);
    assert.strictEqual(released, false);
    assert.strictEqual(cooldowns.has("zai/glm-5.2"), false);
  });
});

describe("Retry-After ヘッダ", () => {
  it("秒数文字列はミリ秒に変換する", () => {
    assert.strictEqual(parseRetryAfter("120"), 120_000);
  });

  it("HTTP-date は残り待機ミリ秒に変換する", () => {
    const sixtySecondsAhead = new Date(Date.now() + 60_000).toUTCString();
    const waitMs = parseRetryAfter(sixtySecondsAhead);
    assert.ok(waitMs !== null && waitMs > 0 && waitMs <= 60_000, "0 < waitMs <= 60000");
  });

  it("未定義・解釈不能は null を返す", () => {
    assert.strictEqual(parseRetryAfter(undefined), null);
    assert.strictEqual(parseRetryAfter("whenever"), null);
  });
});

describe("最終assistantエラーのレート制限判定", () => {
  it("429 をレート制限として扱う", () => {
    assert.equal(isRateLimitedError("Error: 429: too many requests"), true);
  });

  it("1310 をレート制限として扱う", () => {
    assert.equal(isRateLimitedError('Error: {"code":"1310"}'), true);
  });

  it("Weekly Limit Exhausted をレート制限として扱う", () => {
    assert.equal(isRateLimitedError("Weekly Limit Exhausted"), true);
  });

  it("Monthly Limit Exhausted をレート制限として扱う", () => {
    assert.equal(isRateLimitedError("Monthly Limit Exhausted"), true);
  });

  it("一致しないエラーはレート制限として扱わない", () => {
    assert.equal(isRateLimitedError("Error: service unavailable"), false);
  });
});

describe("手動選択の判定", () => {
  it("ユーザーの set / cycle は手動選択とする", () => {
    assert.strictEqual(isManualSelect("set", false), true);
    assert.strictEqual(isManualSelect("cycle", false), true);
  });

  it("自拡張の setModel 中と restore は手動選択としない", () => {
    assert.strictEqual(isManualSelect("set", true), false);
    assert.strictEqual(isManualSelect("restore", false), false);
    assert.strictEqual(isManualSelect(undefined, false), false);
  });
});

let passed = 0;
const failures: string[] = [];
for (const t of tests) {
  try {
    await t.fn();
    passed++;
  } catch (err) {
    failures.push(
      `  \u2717 ${t.name}\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
