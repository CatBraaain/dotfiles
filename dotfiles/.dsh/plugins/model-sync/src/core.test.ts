import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  CACHE_TTL_MS,
  authHeaders,
  catalogBaseUrl,
  composeProviderModels,
  deepEqualJson,
  endpointUrl,
  extractRemoteModels,
  isCacheStale,
  isCachedProviderUsable,
  isSyncableWireApi,
  parseCache,
  sharedInstalledApi,
  type InstalledModel,
  type ModelEntry,
} from "./core.ts";

const zaiInstalled: InstalledModel[] = [
  {
    id: "glm-5.3",
    api: "openai-completions",
    name: "GLM-5.3",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "glm-5.3-flash",
    api: "openai-completions",
    name: "GLM-5.3-Flash",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", high: "high" },
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 131_072,
  },
];

describe("endpointUrl", () => {
  it("appends /models for openai protocols", () => {
    assert.equal(
      endpointUrl("openai-completions", "https://api.z.ai/api/coding/paas/v4"),
      "https://api.z.ai/api/coding/paas/v4/models",
    );
    assert.equal(
      endpointUrl("openai-responses", "https://api.example.com/v1/"),
      "https://api.example.com/v1/models",
    );
  });

  it("normalizes the /v1 suffix for anthropic-messages", () => {
    assert.equal(
      endpointUrl("anthropic-messages", "https://api.anthropic.com"),
      "https://api.anthropic.com/v1/models?limit=1000",
    );
    assert.equal(
      endpointUrl("anthropic-messages", "https://api.anthropic.com/v1"),
      "https://api.anthropic.com/v1/models?limit=1000",
    );
  });
});

describe("catalogBaseUrl", () => {
  it("prefers the deepest catalog path when spellings of the root are mixed", () => {
    const mixed: InstalledModel[] = [
      { id: "a", baseUrl: "https://openrouter.ai/api" },
      { id: "b", baseUrl: "https://openrouter.ai/api/v1" },
    ];
    const base = catalogBaseUrl(mixed);
    assert.equal(base, "https://openrouter.ai/api/v1");
    assert.equal(endpointUrl("openai-completions", base ?? ""), "https://openrouter.ai/api/v1/models");
  });

  it("keeps the first entry when paths have the same depth", () => {
    const tied: InstalledModel[] = [
      { id: "a", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" },
      { id: "b", baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com" },
    ];
    assert.equal(catalogBaseUrl(tied), "https://bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("returns the single base unchanged and skips entries without one", () => {
    const uniform: InstalledModel[] = [
      { id: "a" },
      { id: "b", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    ];
    assert.equal(catalogBaseUrl(uniform), "https://api.z.ai/api/coding/paas/v4");
    assert.equal(catalogBaseUrl([]), undefined);
  });
});

describe("authHeaders", () => {
  it("uses bearer auth for openai protocols", () => {
    const headers = authHeaders("openai-completions", "key-1");
    assert.equal(headers.get("Authorization"), "Bearer key-1");
    assert.equal(headers.get("x-api-key"), null);
  });

  it("uses x-api-key and anthropic-version for anthropic-messages", () => {
    const headers = authHeaders("anthropic-messages", "key-1");
    assert.equal(headers.get("x-api-key"), "key-1");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("Authorization"), null);
  });

  it("switches anthropic oauth tokens to bearer", () => {
    const headers = authHeaders("anthropic-messages", "sk-ant-oat01-token");
    assert.equal(headers.get("Authorization"), "Bearer sk-ant-oat01-token");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  });
});

describe("extractRemoteModels", () => {
  it("extracts ids and names from an OpenAI listing", () => {
    const models = extractRemoteModels("openai", {
      data: [{ id: "glm-6", name: "GLM-6" }, { id: "glm-6-vision" }],
    });
    assert.deepEqual(models, [
      { id: "glm-6", name: "GLM-6" },
      { id: "glm-6-vision", name: undefined },
    ]);
  });

  it("uses display_name for anthropic listings", () => {
    const models = extractRemoteModels("anthropic", {
      data: [{ id: "claude-x", display_name: "Claude X" }],
    });
    assert.deepEqual(models, [{ id: "claude-x", name: "Claude X" }]);
  });

  it("filters non-chat models by id", () => {
    const models = extractRemoteModels("openai", {
      data: [
        { id: "text-embedding-3" },
        { id: "glm-6-tts" },
        { id: "glm-6" },
      ],
    });
    assert.deepEqual(models.map((model) => model.id), ["glm-6"]);
  });

  it("enriches OpenRouter entries with metadata and pricing", () => {
    const models = extractRemoteModels("openai", {
      data: [
        {
          id: "z-ai/glm-6",
          supported_parameters: ["reasoning"],
          architecture: { input_modalities: ["text", "image"] },
          context_length: 262144,
          top_provider: { max_completion_tokens: 98304 },
          pricing: { prompt: "0.0000012", completion: "0.0000044" },
        },
      ],
    });
    assert.deepEqual(models, [
      {
        id: "z-ai/glm-6",
        name: undefined,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262144,
        maxTokens: 98304,
        cost: { input: 1.2, output: 4.4, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("returns nothing for payloads without a data array", () => {
    assert.deepEqual(extractRemoteModels("openai", { error: "nope" }), []);
  });
});

describe("composeProviderModels", () => {
  const modelsDev = {
    models: {
      "glm-6": {
        name: "GLM-6",
        reasoning: true,
        limit: { context: 1_000_000, output: 131_072 },
        modalities: { input: ["text", "image"] },
      },
      "glm-5.3": { limit: { context: 2_000_000 } },
    },
  };
  const remote = [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, { id: "glm-6", name: "GLM-6 Endpoint" }];

  it("synthesizes the whole list when no user models exist", () => {
    const result = composeProviderModels({
      installed: zaiInstalled,
      userModels: undefined,
      previousWritten: [],
      remote,
      modelsDevProvider: modelsDev,
      sharedApi: "openai-completions",
    });

    // Catalog entries stay minimal where models.dev has nothing fresh to add…
    assert.deepEqual(result.entries[0], {
      id: "glm-5.3",
      contextWindow: 2_000_000,
    });
    // …and get a name only when an endpoint or models.dev provides one.
    assert.deepEqual(result.entries[1], { id: "glm-5.3-flash" });
    // A brand-new id gets explicit defaults plus inherited reasoning efforts.
    assert.deepEqual(result.entries[2], {
      id: "glm-6",
      name: "GLM-6 Endpoint",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      input: ["text", "image"],
      reasoningEfforts: { low: "low", high: "high", max: "max" },
    });
    assert.deepEqual(result.newIds, ["glm-6"]);
    assert.deepEqual(result.removedIds, []);
  });

  it("refreshes plugin-owned entries and preserves user-owned ones", () => {
    const userModels: ModelEntry[] = [
      { id: "glm-5.3", contextWindow: 1_000_000 },
      // The user widened this entry themselves: the plugin must not touch it.
      { id: "glm-5.3-flash", name: "My flash" },
    ];
    const result = composeProviderModels({
      installed: zaiInstalled,
      userModels,
      previousWritten: [{ id: "glm-5.3", contextWindow: 1_000_000 }],
      remote,
      modelsDevProvider: modelsDev,
      sharedApi: "openai-completions",
    });

    assert.deepEqual(result.entries[0], { id: "glm-5.3", contextWindow: 2_000_000 });
    assert.equal(result.entries[1], userModels[1]);
    assert.deepEqual(result.newIds, ["glm-6"]);
  });

  it("drops plugin-appended ids the remote no longer lists, but keeps catalog ids", () => {
    const userModels: ModelEntry[] = [
      { id: "glm-9-preview", name: "GLM-9 Preview", contextWindow: 128000, maxTokens: 16384, input: ["text"] },
      { id: "glm-5.3" },
    ];
    const result = composeProviderModels({
      installed: zaiInstalled,
      userModels,
      previousWritten: [
        { id: "glm-9-preview", name: "GLM-9 Preview", contextWindow: 128000, maxTokens: 16384, input: ["text"] },
        { id: "glm-5.3" },
      ],
      remote: [{ id: "glm-5.3" }],
      modelsDevProvider: undefined,
      sharedApi: "openai-completions",
    });

    assert.deepEqual(result.entries, [{ id: "glm-5.3" }]);
    assert.deepEqual(result.removedIds, ["glm-9-preview"]);
    assert.deepEqual(result.newIds, []);
  });

  it("hands a previously plugin-owned entry back untouched once the user edits it", () => {
    const userModels: ModelEntry[] = [{ id: "glm-5.3", contextWindow: 555 }];
    const result = composeProviderModels({
      installed: zaiInstalled,
      userModels,
      previousWritten: [{ id: "glm-5.3", contextWindow: 1_000_000 }],
      remote: [{ id: "glm-5.3" }],
      modelsDevProvider: modelsDev,
      sharedApi: "openai-completions",
    });
    assert.equal(result.entries[0], userModels[0]);
  });

  it("names the wire api explicitly for new ids when the catalog mixes apis", () => {
    const mixed: InstalledModel[] = [
      { id: "a", api: "openai-completions" },
      { id: "b", api: "anthropic-messages" },
    ];
    const result = composeProviderModels({
      installed: mixed,
      userModels: [{ id: "a" }, { id: "b" }],
      previousWritten: [],
      remote: [{ id: "c" }],
      modelsDevProvider: undefined,
      sharedApi: sharedInstalledApi(mixed),
    });
    assert.equal(result.entries[2].api, "openai-completions");
    assert.equal(result.entries[2].contextWindow, 128000);
    assert.equal(result.entries[2].maxTokens, 16384);
    assert.deepEqual(result.entries[2].input, ["text"]);
  });

  it("skips reasoningEfforts inheritance when the catalog has no reasoning model", () => {
    const plain: InstalledModel[] = [{ id: "only", api: "openai-completions", reasoning: false }];
    const result = composeProviderModels({
      installed: plain,
      userModels: [{ id: "only" }],
      previousWritten: [],
      remote: [{ id: "brand-new" }],
      modelsDevProvider: { models: { "brand-new": { reasoning: true } } },
      sharedApi: "openai-completions",
    });
    assert.equal(result.entries[1].reasoningEfforts, undefined);
  });
});

describe("sharedInstalledApi", () => {
  it("returns the common api, or undefined when they disagree", () => {
    assert.equal(sharedInstalledApi(zaiInstalled), "openai-completions");
    assert.equal(
      sharedInstalledApi([
        { id: "a", api: "openai-completions" },
        { id: "b", api: "anthropic-messages" },
      ]),
      undefined,
    );
    assert.equal(sharedInstalledApi([]), undefined);
  });
});

describe("isSyncableWireApi", () => {
  it("accepts the dsh wire protocols and the indeterminate undefined", () => {
    assert.equal(isSyncableWireApi("openai-completions"), true);
    assert.equal(isSyncableWireApi("openai-responses"), true);
    assert.equal(isSyncableWireApi("anthropic-messages"), true);
    assert.equal(isSyncableWireApi(undefined), true);
  });

  it("excludes catalog apis whose wire has no compatible model listing", () => {
    // pi-ai's catalog really contains these two providers.
    assert.equal(isSyncableWireApi("google-generative-ai"), false);
    assert.equal(isSyncableWireApi("bedrock-converse-stream"), false);
  });
});

describe("cache", () => {
  it("round-trips providers, models.dev, and written entries", () => {
    const cache = {
      version: 1 as const,
      providers: {
        zai: {
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          fetchedAt: 1_000,
          models: [{ id: "glm-6", name: "GLM-6" }],
        },
      },
      modelsDev: { fetchedAt: 2_000, providers: { zai: { models: {} } } },
      written: { zai: [{ id: "glm-5.3", contextWindow: 1_000_000 }] },
    };
    const parsed = parseCache(JSON.parse(JSON.stringify(cache)));
    assert.ok(parsed);
    assert.equal(parsed.providers.zai?.baseUrl, cache.providers.zai.baseUrl);
    assert.deepEqual(parsed.written?.zai, cache.written.zai);
    assert.equal(parsed.modelsDev?.fetchedAt, 2_000);
  });

  it("rejects wrong versions and malformed providers", () => {
    assert.equal(parseCache({ version: 2 }), undefined);
    assert.equal(parseCache({ version: 1 }), undefined);
    assert.equal(parseCache({ version: 1, providers: { zai: { baseUrl: "x" } } }), undefined);
  });

  it("drops excluded ids when parsing cached listings", () => {
    const parsed = parseCache({
      version: 1,
      providers: {
        zai: {
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          fetchedAt: 1,
          models: [{ id: "glm-6" }, { id: "glm-6-embedding" }],
        },
      },
    });
    assert.deepEqual(parsed?.providers.zai?.models, [{ id: "glm-6", name: undefined }]);
  });

  it("judges freshness per fetchedAt", () => {
    const now = 10_000_000;
    assert.equal(isCacheStale(undefined, now), true);
    assert.equal(isCacheStale(now - CACHE_TTL_MS + 1, now), false);
    assert.equal(isCacheStale(now - CACHE_TTL_MS, now), true);
    const cached = { baseUrl: "https://api.z.ai/api/coding/paas/v4", fetchedAt: now, models: [{ id: "glm-6" }] };
    assert.equal(isCachedProviderUsable(cached, "https://api.z.ai/api/coding/paas/v4", now), true);
    assert.equal(isCachedProviderUsable(cached, "https://other.example.com", now), false);
  });
});

describe("deepEqualJson", () => {
  it("ignores key order and undefined fields", () => {
    assert.equal(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    assert.equal(deepEqualJson({ a: 1, b: undefined }, { a: 1 }), true);
    assert.equal(deepEqualJson({ a: [1, { c: 2 }] }, { a: [1, { c: 2 }] }), true);
    assert.equal(deepEqualJson({ a: 1 }, { a: 2 }), false);
    assert.equal(deepEqualJson({ a: 1, b: 3 }, { a: 1 }), false);
    assert.equal(deepEqualJson([1, 2], [2, 1]), false);
  });
});
