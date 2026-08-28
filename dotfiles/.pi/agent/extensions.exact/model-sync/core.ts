import type { Api } from "@earendil-works/pi-ai";

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export type AuthScheme = "bearer" | "anthropic" | "google";
export type ResponseShape = "openai" | "anthropic" | "google";

export interface SyncProvider {
  id: string;
  defaultBaseUrl: string;
  endpointPath: string;
  authScheme: AuthScheme;
  responseShape: ResponseShape;
  defaultApi: Api;
  modelsDevId?: string;
}

export const SYNC_PROVIDERS: readonly SyncProvider[] = [
  {
    id: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-responses",
    modelsDevId: "openai",
  },
  {
    id: "openrouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "openrouter",
  },
  {
    id: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "deepseek",
  },
  {
    id: "xai",
    defaultBaseUrl: "https://api.x.ai/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-responses",
    modelsDevId: "xai",
  },
  {
    id: "groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "groq",
  },
  {
    id: "mistral",
    defaultBaseUrl: "https://api.mistral.ai",
    endpointPath: "/v1/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "mistral-conversations",
    modelsDevId: "mistral",
  },
  {
    id: "together",
    defaultBaseUrl: "https://api.together.ai/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "fireworks",
    defaultBaseUrl: "https://api.fireworks.ai/inference",
    endpointPath: "/v1/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "cerebras",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "cerebras",
  },
  {
    id: "nvidia",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "nvidia",
  },
  {
    id: "moonshotai",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "moonshotai",
  },
  {
    id: "moonshotai-cn",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "moonshotai-cn",
  },
  {
    id: "huggingface",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "huggingface",
  },
  {
    id: "zai",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "zai",
  },
  {
    id: "zai-coding-cn",
    defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "baseten",
    defaultBaseUrl: "https://inference.baseten.co/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "baseten",
  },
  {
    id: "ant-ling",
    defaultBaseUrl: "https://api.ant-ling.com/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "xiaomi",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
    modelsDevId: "xiaomi",
  },
  {
    id: "qwen-token-plan",
    defaultBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "qwen-token-plan-cn",
    defaultBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "qwen-token-plan-individual",
    defaultBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    endpointPath: "/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "openai-completions",
  },
  {
    id: "vercel-ai-gateway",
    defaultBaseUrl: "https://ai-gateway.vercel.sh",
    endpointPath: "/v1/models",
    authScheme: "bearer",
    responseShape: "openai",
    defaultApi: "anthropic-messages",
  },
  {
    id: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    endpointPath: "/v1/models",
    authScheme: "anthropic",
    responseShape: "anthropic",
    defaultApi: "anthropic-messages",
    modelsDevId: "anthropic",
  },
  {
    id: "minimax",
    defaultBaseUrl: "https://api.minimax.io/anthropic",
    endpointPath: "/v1/models",
    authScheme: "anthropic",
    responseShape: "anthropic",
    defaultApi: "anthropic-messages",
    modelsDevId: "minimax",
  },
  {
    id: "minimax-cn",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    endpointPath: "/v1/models",
    authScheme: "anthropic",
    responseShape: "anthropic",
    defaultApi: "anthropic-messages",
    modelsDevId: "minimax-cn",
  },
  {
    id: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    endpointPath: "/models?pageSize=1000",
    authScheme: "google",
    responseShape: "google",
    defaultApi: "google-generative-ai",
    modelsDevId: "google",
  },
];

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  [key: string]: unknown;
}

export interface RemoteModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

export interface ModelDefinition {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: unknown;
  samplingParams?: Record<string, unknown>;
  compat?: unknown;
  [key: string]: unknown;
}

export interface CustomModelDefinition {
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: Partial<ModelCost>;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: unknown;
  samplingParams?: Record<string, unknown>;
  compat?: unknown;
}

export interface CachedProvider {
  baseUrl: string;
  fetchedAt: number;
  models: RemoteModel[];
}

export interface CachedModelsDev {
  fetchedAt: number;
  providers: Record<string, ModelsDevProvider>;
}

export interface ModelSyncCache {
  version: 1;
  providers: Record<string, CachedProvider>;
  modelsDev?: CachedModelsDev;
}

export function endpointUrl(provider: SyncProvider, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${provider.endpointPath}`;
}

export function authHeaders(provider: SyncProvider, apiKey: string): Headers {
  const headers = new Headers();

  if (provider.authScheme === "bearer") {
    headers.set("Authorization", `Bearer ${apiKey}`);
  } else if (provider.authScheme === "google") {
    headers.set("x-goog-api-key", apiKey);
  } else {
    headers.set("anthropic-version", "2023-06-01");
    if (provider.id === "anthropic" && apiKey.startsWith("sk-ant-oat")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("anthropic-beta", "oauth-2025-04-20");
    } else {
      headers.set("x-api-key", apiKey);
    }
  }

  return headers;
}

export function extractRemoteModels(provider: SyncProvider, payload: unknown): RemoteModel[] {
  const response = asRecord(payload);
  if (!response) return [];

  const models =
    provider.responseShape === "google"
      ? extractGoogleModels(response)
      : extractDataModels(provider, response);

  return models.filter((model) => !isExcludedModel(model.id));
}

export function composeProviderModels(options: {
  provider: SyncProvider;
  remoteModels: RemoteModel[];
  existingModels: ModelDefinition[];
  customModelIds: ReadonlySet<string>;
  customModelDefinitions?: ReadonlyMap<string, CustomModelDefinition>;
  modelsDevProvider?: ModelsDevProvider;
  baseUrl: string;
}): ModelDefinition[] {
  const existingById = new Map(options.existingModels.map((model) => [model.id, model]));
  const firstExistingModel = options.existingModels[0];
  const remoteIds = new Set(options.remoteModels.map((model) => model.id));

  const syncedModels = options.remoteModels.map((remoteModel) => {
    const existingModel = existingById.get(remoteModel.id);
    const customDefinition = options.customModelDefinitions?.get(remoteModel.id);
    if (existingModel && options.customModelIds.has(remoteModel.id)) return existingModel;
    if (customDefinition) {
      return composeCustomModel(
        remoteModel.id,
        customDefinition,
        existingModel,
        firstExistingModel,
        options.provider,
        options.baseUrl,
      );
    }

    const metadata = options.modelsDevProvider?.models?.[remoteModel.id];
    const metadataInput: ("text" | "image")[] | undefined = metadata?.modalities?.input
      ? metadata.modalities.input.includes("image")
        ? ["text", "image"]
        : ["text"]
      : undefined;
    const metadataCost =
      metadata?.cost?.input !== undefined && metadata.cost.output !== undefined
        ? {
            input: metadata.cost.input,
            output: metadata.cost.output,
            cacheRead: metadata.cost.cache_read ?? 0,
            cacheWrite: metadata.cost.cache_write ?? 0,
          }
        : undefined;

    return {
      ...existingModel,
      id: remoteModel.id,
      name: firstDefined(remoteModel.name, metadata?.name, existingModel?.name, remoteModel.id),
      api: existingModel?.api ?? firstExistingModel?.api ?? options.provider.defaultApi,
      baseUrl: existingModel?.baseUrl ?? firstExistingModel?.baseUrl ?? options.baseUrl,
      reasoning: firstDefined(
        remoteModel.reasoning,
        metadata?.reasoning,
        existingModel?.reasoning,
        false,
      ),
      input: firstDefined(remoteModel.input, metadataInput, existingModel?.input, ["text"] as (
        | "text"
        | "image"
      )[]),
      cost: firstDefined(remoteModel.cost, metadataCost, existingModel?.cost, zeroCost()),
      contextWindow: firstDefined(
        remoteModel.contextWindow,
        metadata?.limit?.context,
        existingModel?.contextWindow,
        128000,
      ),
      maxTokens: firstDefined(
        remoteModel.maxTokens,
        metadata?.limit?.output,
        existingModel?.maxTokens,
        16384,
      ),
    };
  });

  for (const customModelId of options.customModelIds) {
    if (remoteIds.has(customModelId)) continue;
    const customModel = existingById.get(customModelId);
    const customDefinition = options.customModelDefinitions?.get(customModelId);
    if (customModel) {
      syncedModels.push(customModel);
    } else if (customDefinition) {
      syncedModels.push(
        composeCustomModel(
          customModelId,
          customDefinition,
          undefined,
          firstExistingModel,
          options.provider,
          options.baseUrl,
        ),
      );
    }
  }

  return syncedModels;
}

function composeCustomModel(
  id: string,
  customDefinition: CustomModelDefinition,
  existingModel: ModelDefinition | undefined,
  firstExistingModel: ModelDefinition | undefined,
  provider: SyncProvider,
  baseUrl: string,
): ModelDefinition {
  const baseModel = existingModel ?? firstExistingModel;
  const cost = customDefinition.cost
    ? { ...(baseModel?.cost ?? zeroCost()), ...customDefinition.cost }
    : (baseModel?.cost ?? zeroCost());

  return {
    ...baseModel,
    id,
    name: customDefinition.name ?? baseModel?.name ?? id,
    api: customDefinition.api ?? baseModel?.api ?? provider.defaultApi,
    baseUrl: customDefinition.baseUrl ?? baseModel?.baseUrl ?? baseUrl,
    reasoning: customDefinition.reasoning ?? baseModel?.reasoning ?? false,
    input: customDefinition.input ?? baseModel?.input ?? ["text"],
    cost,
    contextWindow: customDefinition.contextWindow ?? baseModel?.contextWindow ?? 128000,
    maxTokens: customDefinition.maxTokens ?? baseModel?.maxTokens ?? 16384,
    thinkingLevelMap: customDefinition.thinkingLevelMap ?? baseModel?.thinkingLevelMap,
    samplingParams: customDefinition.samplingParams ?? baseModel?.samplingParams,
    compat: customDefinition.compat ?? baseModel?.compat,
  };
}

export function isCacheStale(fetchedAt: number | undefined, now = Date.now()): boolean {
  return fetchedAt === undefined || !Number.isFinite(fetchedAt) || now - fetchedAt >= CACHE_TTL_MS;
}

export function isCachedProviderUsable(
  cachedProvider: CachedProvider | undefined,
  baseUrl: string,
): cachedProvider is CachedProvider {
  return cachedProvider?.baseUrl === baseUrl;
}

export function parseCache(value: unknown): ModelSyncCache | undefined {
  const rawCache = asRecord(value);
  if (rawCache?.version !== 1) return undefined;

  const rawProviders = asRecord(rawCache.providers);
  if (!rawProviders) return undefined;

  const providers: Record<string, CachedProvider> = {};
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    const cachedProvider = parseCachedProvider(rawProvider);
    if (cachedProvider) providers[providerId] = cachedProvider;
  }

  const modelsDev = parseCachedModelsDev(rawCache.modelsDev);
  return { version: 1, providers, ...(modelsDev ? { modelsDev } : {}) };
}

function extractDataModels(
  provider: SyncProvider,
  response: Record<string, unknown>,
): RemoteModel[] {
  const data = asArray(response.data);
  if (!data) return [];

  return data.flatMap((entry) => {
    const model = asRecord(entry);
    const id = text(model?.id);
    if (!id) return [];

    const remoteModel: RemoteModel = {
      id,
      name: text(provider.responseShape === "anthropic" ? model?.display_name : model?.name),
    };

    if (provider.id === "openrouter") enrichOpenRouterModel(remoteModel, model);
    return remoteModel;
  });
}

function extractGoogleModels(response: Record<string, unknown>): RemoteModel[] {
  const models = asArray(response.models);
  if (!models) return [];

  return models.flatMap((entry) => {
    const model = asRecord(entry);
    const fullId = text(model?.name);
    const methods = strings(model?.supportedGenerationMethods);
    if (!fullId || !methods.includes("generateContent")) return [];

    return [
      {
        id: fullId.replace(/^models\//, ""),
        name: text(model?.displayName),
      },
    ];
  });
}

function enrichOpenRouterModel(
  remoteModel: RemoteModel,
  model: Record<string, unknown> | undefined,
): void {
  if (!model) return;

  const supportedParameters = asArray(model.supported_parameters);
  if (supportedParameters) {
    const parameterNames = strings(supportedParameters);
    remoteModel.reasoning =
      parameterNames.includes("reasoning") || parameterNames.includes("include_reasoning");
  }

  const architecture = asRecord(model.architecture);
  const inputModalities = asArray(architecture?.input_modalities);
  if (inputModalities) {
    remoteModel.input = strings(inputModalities).includes("image") ? ["text", "image"] : ["text"];
  }

  remoteModel.contextWindow = number(model.context_length);
  remoteModel.maxTokens = number(asRecord(model.top_provider)?.max_completion_tokens);
  remoteModel.cost = openRouterCost(asRecord(model.pricing));
}

function openRouterCost(pricing: Record<string, unknown> | undefined): ModelCost | undefined {
  const input = decimal(pricing?.prompt);
  const output = decimal(pricing?.completion);
  if (input === undefined || output === undefined) return undefined;

  return {
    input: perMillion(input),
    output: perMillion(output),
    cacheRead: perMillion(decimal(pricing?.input_cache_read) ?? 0),
    cacheWrite: perMillion(decimal(pricing?.input_cache_write) ?? 0),
  };
}

function parseCachedProvider(value: unknown): CachedProvider | undefined {
  const rawProvider = asRecord(value);
  const baseUrl = text(rawProvider?.baseUrl);
  const fetchedAt = number(rawProvider?.fetchedAt);
  const rawModels = asArray(rawProvider?.models);
  if (!baseUrl || fetchedAt === undefined || !rawModels) return undefined;

  const models = rawModels.flatMap((model) => parseRemoteModel(model));
  if (models.length === 0) return undefined;
  return { baseUrl, fetchedAt, models };
}

function parseCachedModelsDev(value: unknown): CachedModelsDev | undefined {
  const rawModelsDev = asRecord(value);
  const fetchedAt = number(rawModelsDev?.fetchedAt);
  const providers = asRecord(rawModelsDev?.providers);
  if (fetchedAt === undefined || !providers) return undefined;

  return { fetchedAt, providers: providers as Record<string, ModelsDevProvider> };
}

function parseRemoteModel(value: unknown): RemoteModel[] {
  const rawModel = asRecord(value);
  const id = text(rawModel?.id);
  if (!id || isExcludedModel(id)) return [];

  const input = strings(rawModel?.input);
  const cost = parseCost(rawModel?.cost);
  return [
    {
      id,
      name: text(rawModel?.name),
      reasoning: boolean(rawModel?.reasoning),
      ...(input.length > 0
        ? { input: input.includes("image") ? ["text", "image"] : ["text"] }
        : {}),
      contextWindow: number(rawModel?.contextWindow),
      maxTokens: number(rawModel?.maxTokens),
      ...(cost ? { cost } : {}),
    },
  ];
}

function parseCost(value: unknown): ModelCost | undefined {
  const rawCost = asRecord(value);
  const input = number(rawCost?.input);
  const output = number(rawCost?.output);
  if (input === undefined || output === undefined) return undefined;

  return {
    input,
    output,
    cacheRead: number(rawCost?.cacheRead) ?? 0,
    cacheWrite: number(rawCost?.cacheWrite) ?? 0,
  };
}

function isExcludedModel(modelId: string): boolean {
  const excludedTerms = [
    "embed",
    "whisper",
    "tts",
    "dall-e",
    "gpt-image",
    "imagen",
    "sora",
    "flux",
    "stable-diffusion",
    "diffusion",
    "moderation",
    "guardrail",
    "rerank",
    "babbage",
    "davinci",
    "transcribe",
    "asr",
    "ocr",
    "speech",
  ];
  const normalizedId = modelId.toLowerCase();
  return excludedTerms.some((term) => normalizedId.includes(term));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decimal(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown): string[] {
  const array = asArray(value);
  return array ? array.filter((item): item is string => typeof item === "string") : [];
}

function perMillion(pricePerToken: number): number {
  return Math.round(pricePerToken * 1_000_000 * 10_000) / 10_000;
}

function zeroCost(): ModelCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function firstDefined<T>(...values: (T | undefined)[]): T {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  throw new Error("Expected a fallback value");
}
