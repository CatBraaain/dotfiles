import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  CACHE_TTL_MS,
  SYNC_PROVIDERS,
  authHeaders,
  composeProviderModels,
  endpointUrl,
  extractRemoteModels,
  isCacheStale,
  isCachedProviderUsable,
  parseCache,
  type ModelDefinition,
  type SyncProvider,
} from "./core.ts";


const openRouter = provider("openrouter");
const openai = provider("openai");
const anthropic = provider("anthropic");
const google = provider("google");

function provider(id: string): SyncProvider {
  const foundProvider = SYNC_PROVIDERS.find((candidate) => candidate.id === id);
  assert.ok(foundProvider, `Missing test provider: ${id}`);
  return foundProvider;
}

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: "existing-model",
    name: "Existing model",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 8192,
    maxTokens: 1024,
    compat: { supportsStrictMode: true },
    ...overrides,
  };
}

describe("provider catalog", () => {
  it("spec に列挙した26 Provider を持つ", () => {
    assert.equal(SYNC_PROVIDERS.length, 26);
  });

  it("baseUrl のパスを保って endpoint URL を組み立てる", () => {
    assert.equal(
      endpointUrl(openai, "https://api.openai.com/v1"),
      "https://api.openai.com/v1/models",
    );
    assert.equal(
      endpointUrl(google, "https://generativelanguage.googleapis.com/v1beta/"),
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
  });
});

describe("authHeaders", () => {
  it("Bearer Provider は Authorization header を使う", () => {
    assert.equal(authHeaders(openai, "test-key").get("Authorization"), "Bearer test-key");
  });

  it("Anthropic API key は x-api-key と version を使う", () => {
    const headers = authHeaders(anthropic, "sk-ant-api-key");
    assert.equal(headers.get("x-api-key"), "sk-ant-api-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
  });

  it("Anthropic OAuth token は Bearer と OAuth beta を使う", () => {
    const headers = authHeaders(anthropic, "sk-ant-oat-token");
    assert.equal(headers.get("Authorization"), "Bearer sk-ant-oat-token");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  });

  it("Anthropic API key の途中一致では OAuth header を使わない", () => {
    const headers = authHeaders(anthropic, "sk-ant-api-sk-ant-oat-token");
    assert.equal(headers.get("x-api-key"), "sk-ant-api-sk-ant-oat-token");
    assert.equal(headers.get("Authorization"), null);
  });

  it("Google は x-goog-api-key を使う", () => {
    assert.equal(authHeaders(google, "gemini-key").get("x-goog-api-key"), "gemini-key");
  });
});

describe("extractRemoteModels", () => {
  it("OpenAI 形式から chat model だけを取り出す", () => {
    const extractedModels = extractRemoteModels(openai, {
      data: [{ id: "gpt-5", name: "GPT 5" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }],
    });

    assert.deepEqual(extractedModels, [{ id: "gpt-5", name: "GPT 5" }]);
  });

  it("Anthropic 形式では display_name を表示名に使う", () => {
    const extractedModels = extractRemoteModels(anthropic, {
      data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }],
    });

    assert.deepEqual(extractedModels, [{ id: "claude-sonnet", name: "Claude Sonnet" }]);
  });

  it("Google は generateContent 対応モデルだけを残し models/ 接頭辞を除く", () => {
    const extractedModels = extractRemoteModels(google, {
      models: [
        {
          name: "models/gemini-3-pro",
          displayName: "Gemini 3 Pro",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding-004",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    });

    assert.deepEqual(extractedModels, [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }]);
  });

  it("OpenRouter の context・modalities・pricing・reasoning を取り出す", () => {
    const extractedModels = extractRemoteModels(openRouter, {
      data: [
        {
          id: "anthropic/claude-opus",
          name: "Claude Opus",
          context_length: 1_000_000,
          architecture: { input_modalities: ["text", "image"] },
          top_provider: { max_completion_tokens: 128_000 },
          supported_parameters: ["reasoning", "tools"],
          pricing: {
            prompt: "0.00001",
            completion: "0.00005",
            input_cache_read: "0.000001",
            input_cache_write: "0.0000125",
          },
        },
      ],
    });

    assert.deepEqual(extractedModels, [
      {
        id: "anthropic/claude-opus",
        name: "Claude Opus",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      },
    ]);
  });

  it("OpenRouter の空 capability は models.dev の肯定値より優先する", () => {
    const remoteModels = extractRemoteModels(openRouter, {
      data: [
        {
          id: "provider-text-only",
          architecture: { input_modalities: [] },
          supported_parameters: [],
        },
      ],
    });
    const composedModels = composeProviderModels({
      provider: openRouter,
      remoteModels,
      existingModels: [model({ id: "provider-text-only" })],
      customModelIds: new Set(),
      modelsDevProvider: {
        models: {
          "provider-text-only": {
            reasoning: true,
            modalities: { input: ["text", "image"] },
          },
        },
      },
      baseUrl: "https://openrouter.ai/api/v1",
    });

    assert.equal(composedModels[0]?.reasoning, false);
    assert.deepEqual(composedModels[0]?.input, ["text"]);
  });
});

describe("composeProviderModels", () => {
  it("Provider endpoint、models.dev、既存定義の順で metadata を選び compat を保持する", () => {
    const existingModel = model();
    const composedModels = composeProviderModels({
      provider: openai,
      remoteModels: [
        {
          id: "existing-model",
          contextWindow: 32_000,
          cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      existingModels: [existingModel],
      customModelIds: new Set(),
      modelsDevProvider: {
        models: {
          "existing-model": {
            name: "models.dev name",
            reasoning: true,
            modalities: { input: ["text", "image"] },
            limit: { context: 16_000, output: 8_000 },
            cost: { input: 2, output: 3 },
          },
        },
      },
      baseUrl: "https://api.openai.com/v1",
    });

    assert.deepEqual(composedModels, [
      {
        ...existingModel,
        name: "models.dev name",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32_000,
        maxTokens: 8_000,
        cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("models.json custom model は definition があっても remote にあっても現在の定義をそのまま使う", () => {
    const customModel = model({
      id: "custom-model",
      name: "Custom",
      contextWindow: 4_096,
      customProperty: "preserved",
    });
    const composedModels = composeProviderModels({
      provider: openai,
      remoteModels: [{ id: "custom-model", name: "Remote", contextWindow: 128_000 }],
      existingModels: [customModel],
      customModelIds: new Set(["custom-model"]),
      customModelDefinitions: new Map([["custom-model", { name: "Changed in models.json" }]]),
      baseUrl: "https://api.openai.com/v1",
    });

    assert.deepEqual(composedModels, [customModel]);
  });

  it("models.json の新規 custom model は remote に無くても設定値を反映する", () => {
    const composedModels = composeProviderModels({
      provider: openai,
      remoteModels: [{ id: "remote-model" }],
      existingModels: [model({ id: "remote-model" })],
      customModelIds: new Set(["local-model"]),
      customModelDefinitions: new Map([
        ["local-model", { name: "Local model", contextWindow: 32_000, reasoning: true }],
      ]),
      baseUrl: "https://api.openai.com/v1",
    });

    assert.deepEqual(
      composedModels.map((entry) => [entry.id, entry.name, entry.contextWindow, entry.reasoning]),
      [
        ["remote-model", "Existing model", 8192, false],
        ["local-model", "Local model", 32_000, true],
      ],
    );
  });

  it("remote に無い models.json custom model は追加し、組み込みモデルは落とす", () => {
    const staticModel = model({ id: "static-model" });
    const customModel = model({ id: "custom-model" });
    const composedModels = composeProviderModels({
      provider: openai,
      remoteModels: [{ id: "remote-model" }],
      existingModels: [staticModel, customModel],
      customModelIds: new Set(["custom-model"]),
      baseUrl: "https://api.openai.com/v1",
    });

    assert.deepEqual(
      composedModels.map((entry) => entry.id),
      ["remote-model", "custom-model"],
    );
    assert.equal(composedModels[0]?.api, "openai-completions");
    assert.equal(composedModels[0]?.contextWindow, 128_000);
  });
});

describe("cache", () => {
  it("有効な cache を復元し、baseUrl 一致時だけ使う", () => {
    const cachedModels = parseCache({
      version: 1,
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          fetchedAt: 1_000,
          models: [{ id: "gpt-5" }],
        },
      },
      modelsDev: { fetchedAt: 1_000, providers: {} },
    });

    assert.ok(cachedModels);
    assert.ok(isCachedProviderUsable(cachedModels.providers.openai, "https://api.openai.com/v1"));
    assert.ok(
      !isCachedProviderUsable(cachedModels.providers.openai, "https://proxy.example.com/v1"),
    );
  });

  it("12時間以上経過した cache を stale と判定する", () => {
    const now = 100 * CACHE_TTL_MS;
    assert.ok(!isCacheStale(now - CACHE_TTL_MS + 1, now));
    assert.ok(isCacheStale(now - CACHE_TTL_MS, now));
  });

  it("壊れた cache を無効として扱う", () => {
    assert.equal(parseCache({ version: 2, providers: {} }), undefined);
    assert.equal(parseCache({ version: 1, providers: "invalid" }), undefined);
  });
});
