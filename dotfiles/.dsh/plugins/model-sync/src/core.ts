// Pure logic for the model-sync plugin: endpoint URLs, auth headers, remote
// model extraction, metadata composition, and cache (de)serialization.
//
// No imports and no I/O — everything here is deterministic and unit-tested in
// core.test.ts. The dsh-facing wiring (settings, credentials, fetch) lives in
// index.ts.

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const CACHE_VERSION = 1;

export type WireApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type ResponseShape = "openai" | "anthropic";

export type ModelInput = ("text" | "image")[];

/** One model entry as stored in settings `llm-pi-ai.providers.<id>.models`. */
export interface ModelEntry {
  id: string;
  api?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput;
  reasoningEfforts?: Record<string, string> | false;
  [key: string]: unknown;
}

/** One model of the pi-ai installed catalog (structural subset). */
export interface InstalledModel {
  id: string;
  api?: string;
  name?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null> | null;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/** A model listed by the provider endpoint, after extraction and filtering. */
export interface RemoteModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ModelInput;
  contextWindow?: number;
  maxTokens?: number;
  /** OpenRouter-only endpoint pricing. Kept for cache fidelity; not writable to settings. */
  cost?: ModelCost;
}

export interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
}

export interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
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
  written?: Record<string, ModelEntry[]>;
}

export interface ComposeResult {
  entries: ModelEntry[];
  /** Remote model ids appended by this composition (absent from the previous list). */
  newIds: string[];
  /** Plugin-owned, non-catalog ids dropped because the remote no longer lists them. */
  removedIds: string[];
}

// ---------------------------------------------------------------------------
// Endpoint URL and auth headers
// ---------------------------------------------------------------------------

const ANTHROPIC_MODEL_LIMIT = 1000;

/** Build the model-listing URL for one route, mirroring dsh-llm-pi-ai's listingUrl. */
export function endpointUrl(api: WireApi | undefined, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (api !== "anthropic-messages") return `${base}/models`;
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${root}/v1/models?limit=${ANTHROPIC_MODEL_LIMIT}`;
}

/**
 * The catalog base URL for the model-listing endpoint.
 *
 * Catalog entries may spell the same root differently — openrouter lists most
 * models under `https://openrouter.ai/api/v1` and a few under
 * `https://openrouter.ai/api` — and only the deepest path serves
 * `{base}/models`. The longest URL path wins; ties keep the catalog's first
 * entry, which preserves the first-occurrence choice on uniform catalogs.
 */
export function catalogBaseUrl(installed: readonly InstalledModel[]): string | undefined {
  let chosen: string | undefined;
  let chosenDepth = -1;
  for (const model of installed) {
    if (model.baseUrl === undefined) continue;
    const depth = urlPathDepth(model.baseUrl);
    if (depth > chosenDepth) {
      chosen = model.baseUrl;
      chosenDepth = depth;
    }
  }
  return chosen;
}

function urlPathDepth(baseUrl: string): number {
  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, "");
    return path === "" ? 0 : path.split("/").length - 1;
  } catch {
    return 0; // not a parseable URL: depth 0, so the first occurrence wins
  }
}

export function authHeaders(api: WireApi | undefined, apiKey: string): Headers {
  const headers = new Headers();
  if (api === "anthropic-messages") {
    headers.set("anthropic-version", "2023-06-01");
    if (apiKey.startsWith("sk-ant-oat")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("anthropic-beta", "oauth-2025-04-20");
    } else {
      headers.set("x-api-key", apiKey);
    }
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Remote model extraction
// ---------------------------------------------------------------------------

export function extractRemoteModels(shape: ResponseShape, payload: unknown): RemoteModel[] {
  const response = asRecord(payload);
  if (!response) return [];
  const models = shape === "anthropic" ? extractAnthropicModels(response) : extractOpenAiModels(response);
  return models.filter((model) => !isExcludedModel(model.id));
}

function extractOpenAiModels(response: Record<string, unknown>): RemoteModel[] {
  const data = asArray(response.data);
  if (!data) return [];
  return data.flatMap((entry) => {
    const model = asRecord(entry);
    const id = text(model?.id);
    if (!id) return [];
    const remoteModel: RemoteModel = { id, name: text(model?.name) };
    enrichOpenRouterModel(remoteModel, model);
    return [remoteModel];
  });
}

function extractAnthropicModels(response: Record<string, unknown>): RemoteModel[] {
  const data = asArray(response.data);
  if (!data) return [];
  return data.flatMap((entry) => {
    const model = asRecord(entry);
    const id = text(model?.id);
    if (!id) return [];
    return [{ id, name: text(model?.display_name) }];
  });
}

function enrichOpenRouterModel(remoteModel: RemoteModel, model: Record<string, unknown> | undefined): void {
  if (!model) return;

  const supportedParameters = asArray(model.supported_parameters);
  if (supportedParameters) {
    const names = strings(supportedParameters);
    remoteModel.reasoning = names.includes("reasoning") || names.includes("include_reasoning");
  }

  const architecture = asRecord(model.architecture);
  const inputModalities = asArray(architecture?.input_modalities);
  if (inputModalities) {
    remoteModel.input = strings(inputModalities).includes("image") ? ["text", "image"] : ["text"];
  }

  const contextWindow = number(model.context_length);
  if (contextWindow !== undefined) remoteModel.contextWindow = contextWindow;
  const maxTokens = number(asRecord(model.top_provider)?.max_completion_tokens);
  if (maxTokens !== undefined) remoteModel.maxTokens = maxTokens;
  const cost = openRouterCost(asRecord(model.pricing));
  if (cost !== undefined) remoteModel.cost = cost;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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

const EXCLUDED_TERMS = [
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

export function isExcludedModel(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase();
  return EXCLUDED_TERMS.some((term) => normalizedId.includes(term));
}

// ---------------------------------------------------------------------------
// Entry composition
// ---------------------------------------------------------------------------

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

export interface ComposeInput {
  installed: readonly InstalledModel[];
  /** Current user `models` array from the raw settings section, when present. */
  userModels: readonly ModelEntry[] | undefined;
  /** Entries the plugin wrote on the previous successful sync. */
  previousWritten: readonly ModelEntry[];
  remote: readonly RemoteModel[];
  modelsDevProvider: ModelsDevProvider | undefined;
  /** The catalog's shared wire api, when every installed model agrees on one. */
  sharedApi: string | undefined;
}

/**
 * Compose the next `models` entry array for one provider.
 *
 * - Entries the user owns are preserved verbatim.
 * - Plugin-owned entries are recomposed from remote + models.dev metadata.
 * - Remote ids absent from the current list are appended.
 * - Plugin-owned, non-catalog ids the remote no longer lists are dropped.
 * - Fields with no fresh value are omitted when an installed catalog entry of
 *   the same id exists (the catalog value is inherited at resolve time); new
 *   ids get explicit defaults instead.
 */
export function composeProviderModels(input: ComposeInput): ComposeResult {
  const { installed, userModels, previousWritten, remote, modelsDevProvider, sharedApi } = input;

  const installedById = new Map(installed.map((model) => [model.id, model]));
  const remoteById = new Map(remote.map((model) => [model.id, model]));
  const writtenById = new Map(previousWritten.map((entry) => [entry.id, entry]));

  const firstInstalledApi = installed[0]?.api;
  const installedIds = new Set(installedById.keys());
  // Without a user `models` array the plugin owns the whole synthesized list.
  const userOwnsList = userModels !== undefined;

  const entries: ModelEntry[] = [];
  const keptIds = new Set<string>();
  const newIds: string[] = [];
  const removedIds: string[] = [];

  const currentList = userModels ?? installed.map((model) => ({ id: model.id }) satisfies ModelEntry);

  for (const entry of currentList) {
    keptIds.add(entry.id);
    const owned = !userOwnsList || isPluginOwned(entry, writtenById);
    const base = installedById.get(entry.id);
    const remoteModel = remoteById.get(entry.id);

    if (remoteModel) {
      if (owned) {
        entries.push(composeEntry(entry.id, remoteModel, modelsDevProvider, base, sharedApi, installed));
      } else {
        entries.push(entry);
      }
      continue;
    }
    if (owned && !base) {
      // Plugin-appended model the remote no longer lists.
      removedIds.push(entry.id);
      continue;
    }
    // User-owned, or an installed catalog id: keep even when the remote omits it.
    entries.push(entry);
  }

  for (const model of remote) {
    if (keptIds.has(model.id)) continue;
    keptIds.add(model.id);
    entries.push(composeEntry(model.id, model, modelsDevProvider, installedById.get(model.id), sharedApi, installed));
    newIds.push(model.id);
  }

  return { entries, newIds, removedIds };
}

function isPluginOwned(entry: ModelEntry, writtenById: Map<string, ModelEntry>): boolean {
  const written = writtenById.get(entry.id);
  return written !== undefined && deepEqualJson(entry, written);
}

function composeEntry(
  id: string,
  remoteModel: RemoteModel,
  modelsDevProvider: ModelsDevProvider | undefined,
  base: InstalledModel | undefined,
  sharedApi: string | undefined,
  installed: readonly InstalledModel[],
): ModelEntry {
  const metadata = modelsDevProvider?.models?.[id];
  const entry: ModelEntry = { id };

  const name = firstDefined(remoteModel.name, metadata?.name);
  if (name !== undefined) entry.name = name;
  else if (!base) entry.name = id;

  const contextWindow = positiveInt(remoteModel.contextWindow) ?? positiveInt(metadata?.limit?.context);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  else if (!base) entry.contextWindow = DEFAULT_CONTEXT_WINDOW;

  const maxTokens = positiveInt(remoteModel.maxTokens) ?? positiveInt(metadata?.limit?.output);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  else if (!base) entry.maxTokens = DEFAULT_MAX_TOKENS;

  const input = remoteModel.input ?? modelsDevInput(metadata);
  if (input !== undefined) entry.input = input;
  else if (!base) entry.input = ["text"];

  // A brand-new reasoning model inherits the thinking-level wire spellings from
  // the catalog's first reasoning model of the same provider.
  if (!base && metadata?.reasoning === true) {
    const efforts = inheritedReasoningEfforts(installed);
    if (efforts !== undefined) entry.reasoningEfforts = efforts;
  }
  // A new id on a catalog whose apis are mixed must name its wire api.
  if (!base && sharedApi === undefined && installed[0]?.api !== undefined) {
    entry.api = installed[0].api;
  }
  return entry;
}

function inheritedReasoningEfforts(installed: readonly InstalledModel[]): Record<string, string> | undefined {
  for (const model of installed) {
    if (model.reasoning !== true) continue;
    const map = model.thinkingLevelMap;
    if (!map) continue;
    const efforts: Record<string, string> = {};
    for (const [level, wire] of Object.entries(map)) {
      if (typeof wire === "string" && wire.length > 0) efforts[level] = wire;
    }
    if (Object.keys(efforts).length > 0) return efforts;
  }
  return undefined;
}

function modelsDevInput(metadata: ModelsDevModel | undefined): ModelInput | undefined {
  const input = metadata?.modalities?.input;
  if (!input) return undefined;
  return input.includes("image") ? ["text", "image"] : ["text"];
}

/** The catalog's shared wire api, or undefined when the installed models disagree. */
export function sharedInstalledApi(installed: readonly InstalledModel[]): string | undefined {
  if (installed.length === 0) return undefined;
  const first = installed[0].api;
  if (first === undefined) return undefined;
  return installed.every((model) => model.api === first) ? first : undefined;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function isCacheStale(fetchedAt: number | undefined, now = Date.now()): boolean {
  return fetchedAt === undefined || !Number.isFinite(fetchedAt) || now - fetchedAt >= CACHE_TTL_MS;
}

/** A cached provider listing is usable when it is fresh and matches the current endpoint base. */
export function isCachedProviderUsable(
  cached: CachedProvider | undefined,
  baseUrl: string,
  now = Date.now(),
): cached is CachedProvider {
  return cached !== undefined && cached.baseUrl === baseUrl && !isCacheStale(cached.fetchedAt, now);
}

export function parseCache(value: unknown): ModelSyncCache | undefined {
  const rawCache = asRecord(value);
  if (rawCache?.version !== CACHE_VERSION) return undefined;

  const rawProviders = asRecord(rawCache.providers);
  if (!rawProviders) return undefined;

  const providers: Record<string, CachedProvider> = {};
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    const cachedProvider = parseCachedProvider(rawProvider);
    if (cachedProvider) providers[providerId] = cachedProvider;
  }

  const modelsDev = parseCachedModelsDev(rawCache.modelsDev);
  const written = parseWritten(rawCache.written);
  if (Object.keys(providers).length === 0 && modelsDev === undefined && written === undefined) {
    return undefined; // nothing usable was recovered: treat the cache as absent
  }
  return {
    version: 1,
    providers,
    ...(modelsDev ? { modelsDev } : {}),
    ...(written ? { written } : {}),
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

function parseWritten(value: unknown): Record<string, ModelEntry[]> | undefined {
  const rawWritten = asRecord(value);
  if (!rawWritten) return undefined;
  const written: Record<string, ModelEntry[]> = {};
  for (const [providerId, rawEntries] of Object.entries(rawWritten)) {
    const entries = (asArray(rawEntries) ?? []).flatMap((entry) => {
      const record = asRecord(entry);
      const id = text(record?.id);
      return id ? [{ ...(record as ModelEntry), id }] : [];
    });
    if (entries.length > 0) written[providerId] = entries;
  }
  return Object.keys(written).length > 0 ? written : undefined;
}

function parseRemoteModel(value: unknown): RemoteModel[] {
  const rawModel = asRecord(value);
  const id = text(rawModel?.id);
  if (!id || isExcludedModel(id)) return [];

  const model: RemoteModel = { id, name: text(rawModel?.name) };
  const reasoning = boolean(rawModel?.reasoning);
  if (reasoning !== undefined) model.reasoning = reasoning;
  const input = strings(rawModel?.input);
  if (input.length > 0) model.input = input.includes("image") ? ["text", "image"] : ["text"];
  const contextWindow = number(rawModel?.contextWindow);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = number(rawModel?.maxTokens);
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const cost = parseCost(rawModel?.cost);
  if (cost !== undefined) model.cost = cost;
  return [model];
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

// ---------------------------------------------------------------------------
// Comparison and coercion helpers
// ---------------------------------------------------------------------------

/** JSON-level deep equality: key order and `undefined` fields do not matter. */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
    const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqualJson(a[key], b[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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

function positiveInt(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function decimal(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
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

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}
