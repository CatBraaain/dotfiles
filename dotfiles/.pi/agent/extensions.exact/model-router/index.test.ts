// 実行: bun --install=auto run index.test.ts
//
// `when` は冪等なフェイクコマンド（echo 1=有効 / exit 1=無効）で駆動する。

import assert from "node:assert/strict";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bashExecFrom,
  decideFallback,
  evalWhen,
  requiresSwitchConfirmation,
  isCoolingDown,
  lastUserText,
  loadConfigFromPath,
  parseRetryAfter,
  pickCandidate,
  recordCooldown,
} from "./index";
import type { Rule } from "./index";

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
  rules: Rule[],
  {
    available = availableModels,
    cooldowns = new Map<string, number>(),
  }: {
    available?: ModelFound[];
    cooldowns?: Map<string, number>;
  } = {},
): Promise<ModelFound | null> => pickCandidate(rules, cooldowns, findIn(available), runWhen, 0);

const writeConfig = (dir: string, name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"));
  return path;
};

const silently = <T>(fn: () => T): T => {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
};

describe("UC1: when 条件で最初の候補を選ぶ", () => {
  it("when が通るルールを採用する", async () => {
    const rules: Rule[] = [
      { provider: "zai", model: "glm-5.2", when: exitZeroCommand },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(rules);
    assert.strictEqual(selectedModel?.id, "glm-5.2");
  });

  it("when が外れたルールは次候補へフォールスルーする", async () => {
    const rules: Rule[] = [
      { provider: "zai", model: "glm-5.2", when: exitOneCommand },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(rules);
    assert.strictEqual(selectedModel?.id, "glm-5.1");
  });

  it("when 無しは常に候補になる", async () => {
    const rules: Rule[] = [
      { provider: "zai", model: "free" },
      { provider: "zai", model: "paid" },
    ];
    const selectedModel = await route(rules);
    assert.strictEqual(selectedModel?.id, "free");
  });

  it("利用可能モデルに無いものは when に関わらず飛ばす", async () => {
    const rules: Rule[] = [
      { provider: "zai", model: "ghost", when: exitZeroCommand },
      { provider: "zai", model: "real", when: exitZeroCommand },
    ];
    const availables = [{ provider: "zai", id: "real" }];
    const selectedModel = await route(rules, { available: availables });
    assert.strictEqual(selectedModel?.id, "real");
  });
});

describe("UC2: rate limit で制限モデルを退避し、次候補へ fallback", () => {
  it("制限中の上位モデルを飛ばして下位モデルを採用する", async () => {
    const rules: Rule[] = [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const glm52InCooldown = new Map<string, number>();
    recordCooldown(glm52InCooldown, "zai/glm-5.2", 60_000, 0);

    const selectedModel = await route(rules, { cooldowns: glm52InCooldown });
    assert.strictEqual(selectedModel?.id, "glm-5.1");
  });

  it("全候補が外れたら null を返す", async () => {
    const rules: Rule[] = [{ provider: "zai", model: "x", when: exitOneCommand }];
    const selectedModel = await route(rules);
    assert.strictEqual(selectedModel, null);
  });
});

describe("UC3: cooldown 期限が過ぎたら再候補化する", () => {
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

describe("UC4: セッション開始時の切替確認", () => {
  it("初回起動では確認を求めない", () => {
    assert.strictEqual(requiresSwitchConfirmation("startup"), false);
  });

  it("new では確認を求めない", () => {
    assert.strictEqual(requiresSwitchConfirmation("new"), false);
  });

  it("reload と復元では確認を求める", () => {
    assert.strictEqual(requiresSwitchConfirmation("reload"), true);
    assert.strictEqual(requiresSwitchConfirmation("resume"), true);
  });
});

describe("UC5: 手動選択中の rate limit fallback", () => {
  const fallbackModel = { provider: "zai", id: "glm-5.1" };

  it("manual でなければ即座に切替する", () => {
    assert.deepStrictEqual(decideFallback(false, fallbackModel), {
      kind: "switch",
      model: fallbackModel,
    });
  });

  it("manual 中は切替前に確認を求める", () => {
    assert.deepStrictEqual(decideFallback(true, fallbackModel), {
      kind: "confirm",
      model: fallbackModel,
    });
  });

  it("fallback 候補が無ければ manual に関わらずエラーにする", () => {
    assert.deepStrictEqual(decideFallback(false, null), { kind: "error" });
    assert.deepStrictEqual(decideFallback(true, null), { kind: "error" });
  });
});

describe("UC6: config.yaml を順序通り安全に読み込む", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "mr-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rules を上から下へ順序を保って解析する", () =>
    withTmpDir((dir) => {
      const path = writeConfig(dir, "c.yaml", [
        "rules:",
        "  - provider: zai",
        "    model: glm-5.2",
        "  - provider: zai",
        "    model: glm-5.1",
      ]);
      const { rules } = loadConfigFromPath(path);
      assert.deepStrictEqual(rules, [
        { provider: "zai", model: "glm-5.2" },
        { provider: "zai", model: "glm-5.1" },
      ]);
    }));

  it("不正ルールがあればルーティングを停止し、原因を収集する", () =>
    withTmpDir((dir) => {
      const path = writeConfig(dir, "c.yaml", [
        "rules:",
        "  - provider: zai",
        "    model: glm-5.2",
        "  - model: nope", // provider 無し
        "  - provider: zai",
        "    model: glm-5.1",
        "    when: 123", // when が数値
      ]);
      const { rules, invalid } = loadConfigFromPath(path);
      assert.deepStrictEqual(rules, []); // 部分適用せず停止
      assert.deepStrictEqual(invalid, [
        { model: "nope" },
        { provider: "zai", model: "glm-5.1", when: 123 },
      ]);
    }));

  it("存在しないファイルは空配列を返す（例外を投げない）", () =>
    withTmpDir((dir) => {
      const { rules } = loadConfigFromPath(join(dir, "nope.yaml"));
      assert.deepStrictEqual(rules, []);
    }));

  it("壊れた YAML は空配列を返す（例外を投げない）", () =>
    withTmpDir((dir) => {
      const broken = writeConfig(dir, "b.yaml", ["rules: [this is broken"]);
      const { rules } = silently(() => loadConfigFromPath(broken));
      assert.deepStrictEqual(rules, []);
    }));
});

describe("UC7: Retry-After ヘッダから cooldown 期間を読む", () => {
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

describe("UC8: 再送は直近のユーザ発言を送る", () => {
  type Entry = { type: string; message: { role: string; content: unknown } };
  const message = (role: string, content: unknown): Entry => ({
    type: "message",
    message: { role, content },
  });

  it("branch 内の直近のユーザ発言を返す", () => {
    const branch = [
      message("user", "first"),
      message("assistant", "hi"),
      message("user", "second"),
    ];
    const text = lastUserText(branch as never);
    assert.strictEqual(text, "second");
  });

  it("ユーザ発言が無ければ null を返す", () => {
    const branch = [message("assistant", "hi")];
    const text = lastUserText(branch as never);
    assert.strictEqual(text, null);
  });

  it("複数パートのテキストは連結する", () => {
    const branch = [
      message("user", [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ];
    const text = lastUserText(branch as never);
    assert.strictEqual(text, "a\nb");
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
