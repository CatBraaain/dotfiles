import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  compareVersionStrings,
  isManualSelect,
  isRateLimitedError,
  misattributedHttp429ModelKey,
  pickCandidates,
  resolveCandidates,
  resolveLatestModel,
  type ModelCandidate,
} from "./routing";

type ModelFound = { provider: string; id: string };

const findIn =
  (available: ModelFound[]) =>
  (provider: string, id: string): ModelFound | undefined =>
    available.find((m) => m.provider === provider && m.id === id);

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
): Promise<ModelFound | null> => routeFirst(candidates, cooldowns, available);

async function routeFirst(
  candidates: ModelCandidate[],
  cooldowns: Map<string, number>,
  available: ModelFound[],
): Promise<ModelFound | null> {
  return (await pickCandidates(candidates, cooldowns, findIn(available), 0))[0] ?? null;
}

describe("class の候補選択", () => {
  it("先頭の候補を採用する", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel?.id, "glm-5.2");
  });

  it("レジストリに存在しない候補は次候補へフォールスルーする", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "missing" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModel = await route(candidates);
    assert.strictEqual(selectedModel?.id, "glm-5.1");
  });
});

describe("レート制限エラーの判定", () => {
  it("429 をレート制限として扱う", () => {
    assert.equal(isRateLimitedError("HTTP 429 Too Many Requests"), true);
  });

  it("関係のないエラーをレート制限として扱わない", () => {
    assert.equal(isRateLimitedError("some network error"), false);
  });

  it("undefined をレート制限として扱わない", () => {
    assert.equal(isRateLimitedError(undefined), false);
  });

  it("Z.AI の usage quota コードをレート制限として扱う", () => {
    assert.equal(isRateLimitedError('{"error":{"code":"1310"}}'), true);
  });
});

describe("HTTP 429 error model attribution", () => {
  it("keeps a model's own HTTP 429 error attributed to that model", () => {
    const sourceModelKey = misattributedHttp429ModelKey(
      "Codex error: The usage limit has been reached",
      "zai/glm-5.2",
      new Set(["zai/glm-5.2"]),
    );
    assert.equal(sourceModelKey, null);
  });

  it("does not attribute generic usage limits to a previous HTTP 429 model", () => {
    const sourceModelKey = misattributedHttp429ModelKey(
      "Codex error: The usage limit has been reached",
      "zai/glm-5.2",
      new Set(["commandcode/gpt-5.6-luna"]),
    );
    assert.equal(sourceModelKey, null);
  });
});

describe("手動選択の判定", () => {
  it("ユーザーの set / cycle は手動選択とする", () => {
    assert.strictEqual(isManualSelect("set", false), true);
    assert.strictEqual(isManualSelect("cycle", false), true);
  });

  it("自拡張の setModel 中と restore は手動選択としない", () => {
    assert.strictEqual(isManualSelect("set", true), false);
    assert.strictEqual(isManualSelect("cycle", true), false);
    assert.strictEqual(isManualSelect("restore", false), false);
    assert.strictEqual(isManualSelect(undefined, false), false);
  });
});

describe("usage スコアによる候補の並べ替え", () => {
  it("sortByScore が返した順序で最初のモデルを採用する", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModels = await pickCandidates(
      candidates,
      new Map(),
      findIn(availableModels),
      0,
      async () => [candidates[1]!, candidates[0]!],
    );
    assert.deepEqual(
      selectedModels.map((model) => model.id),
      ["glm-5.1", "glm-5.2"],
    );
  });

  it("sortByScore が null のときは配列順の先頭を採用する", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
    ];
    const selectedModels = await pickCandidates(
      candidates,
      new Map(),
      findIn(availableModels),
      0,
      async () => null,
    );
    assert.deepEqual(
      selectedModels.map((model) => model.id),
      ["glm-5.2", "glm-5.1"],
    );
  });

  it("生存候補が1件のときは sortByScore を呼ばない", async () => {
    let scoreCalls = 0;
    const [selectedModel] = await pickCandidates(
      [{ provider: "zai", model: "glm-5.2" }],
      new Map(),
      findIn(availableModels),
      0,
      async (candidates) => {
        scoreCalls++;
        return candidates;
      },
    );
    assert.strictEqual(selectedModel?.id, "glm-5.2");
    assert.strictEqual(scoreCalls, 0);
  });

  it("sortByScore は cooldown 後の生存候補だけを受ける", async () => {
    const candidates: ModelCandidate[] = [
      { provider: "zai", model: "free" },
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
      { provider: "zai", model: "x" },
    ];
    let received: readonly ModelCandidate[] = [];
    await pickCandidates(
      candidates,
      new Map([["zai/free", 10_000]]),
      findIn(availableModels),
      0,
      async (receivedCandidates) => {
        received = receivedCandidates;
        return null;
      },
    );
    assert.deepEqual(received, [
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.1" },
      { provider: "zai", model: "x" },
    ]);
  });
});

describe("<LATEST> テンプレートの解決", () => {
  const zaiCatalog = ["glm-5.2", "glm-5.3", "glm-5.3-flash", "glm-5.3.1", "glm-5.10", "glm-4.9"];

  it("完全一致した id のうち最高の版を採用する", () => {
    assert.equal(resolveLatestModel("glm-<LATEST>", zaiCatalog), "glm-5.10");
    assert.equal(resolveLatestModel("glm-<LATEST>-flash", zaiCatalog), "glm-5.3-flash");
  });

  it("版は数値セグメント比較で、全等ならセグメント数が多い方を採る", () => {
    assert.equal(compareVersionStrings("5.10", "5.9") > 0, true);
    assert.equal(compareVersionStrings("5.3", "5.28") < 0, true);
    assert.equal(compareVersionStrings("5.3", "5.3.1") < 0, true);
    assert.equal(compareVersionStrings("5.3.1", "5.3") > 0, true);
    assert.equal(compareVersionStrings("5", "5.0") < 0, true);
    assert.equal(compareVersionStrings("5.3", "5.3"), 0);
    assert.equal(resolveLatestModel("glm-<LATEST>", ["glm-5.3", "glm-5.3.1"]), "glm-5.3.1");
  });

  it("テンプレートに一致する id がなければ null", () => {
    assert.equal(resolveLatestModel("glm-<LATEST>", ["glm-5.3-flash", "glm-air"]), null);
    assert.equal(resolveLatestModel("glm-<LATEST>", []), null);
  });

  it("候補単位では一致しない候補を除外し、トークンなしの候補はそのまま通す", () => {
    const catalog: Record<string, readonly string[]> = {
      zai: ["glm-5.2", "glm-5.3"],
      commandcode: ["z-ai/glm-5.3-flash"],
    };
    const resolved = resolveCandidates(
      [
        { provider: "commandcode", model: "z-ai/glm-<LATEST>-flash" },
        { provider: "zai", model: "glm-<LATEST>", weight: 2 },
        { provider: "zai", model: "glm-5.2" },
        { provider: "zai", model: "glm-<LATEST>-air" },
      ],
      (provider) => catalog[provider] ?? [],
    );
    assert.deepEqual(resolved, [
      { provider: "commandcode", model: "z-ai/glm-5.3-flash" },
      { provider: "zai", model: "glm-5.3", weight: 2 },
      { provider: "zai", model: "glm-5.2" },
    ]);
  });
});
