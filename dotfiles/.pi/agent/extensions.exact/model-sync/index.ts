import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Models, type Provider as ModelsDevSdkProvider } from "@opencode-ai/models";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SYNC_PROVIDERS,
  authHeaders,
  composeProviderModels,
  endpointUrl,
  extractRemoteModels,
  isCacheStale,
  isCachedProviderUsable,
  parseCache,
  type CustomModelDefinition,
  type ModelDefinition,
  type ModelSyncCache,
  type ModelsDevProvider,
  type RemoteModel,
  type SyncProvider,
} from "./core.ts";

type ProviderSyncResult =
  | { provider: string; status: "success"; modelCount: number; newCount: number }
  | { provider: string; status: "no-auth" }
  | { provider: string; status: "failed"; error: string };

type SyncReport = {
  providerResults: ProviderSyncResult[];
  warnings: string[];
  attemptedCount: number;
  successfulCount: number;
};

type CustomModelIds = {
  idsByProvider: Map<string, Set<string>>;
  definitionsByProvider: Map<string, Map<string, CustomModelDefinition>>;
  warning?: string;
};

type ResolvedProvider = {
  provider: SyncProvider;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, unknown>;
};

let cache: ModelSyncCache | undefined;
let inFlightSync: Promise<SyncReport> | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;

    const cacheResult = await loadCache();
    cache = cacheResult.cache;

    const customModelIds = await readCustomModelIds();
    if (cache) applyCachedModels(pi, ctx, cache, customModelIds);

    if (needsBackgroundRefresh(ctx, cache)) startBackgroundSync(pi, ctx);
  });

  pi.registerCommand("model-sync", {
    description: "Fetch current provider model lists and refresh the model-sync cache",
    handler: async (_args, ctx) => {
      const report = await runSync(pi, ctx, true);
      if (ctx.hasUI)
        ctx.ui.notify(formatReport(report), report.successfulCount > 0 ? "info" : "warning");
    },
  });
}

function applyCachedModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cachedModels: ModelSyncCache,
  customModels: CustomModelIds,
): void {
  const existingModels = ctx.modelRegistry.getAll() as unknown as ModelDefinition[];

  for (const provider of SYNC_PROVIDERS) {
    if (!ctx.modelRegistry.getProviderAuthStatus(provider.id).configured) continue;

    const baseUrl = providerBaseUrl(ctx, provider);
    const cachedProvider = cachedModels.providers[provider.id];
    if (!isCachedProviderUsable(cachedProvider, baseUrl)) continue;

    const models = composeProviderModels({
      provider,
      remoteModels: cachedProvider.models,
      existingModels: modelsForProvider(existingModels, provider.id),
      customModelIds: customModels.idsByProvider.get(provider.id) ?? new Set(),
      customModelDefinitions: customModels.definitionsByProvider.get(provider.id),
      modelsDevProvider: cachedModels.modelsDev?.providers[provider.modelsDevId ?? ""],
      baseUrl,
    });
    registerModels(pi, provider, models);
  }
}

function needsBackgroundRefresh(
  ctx: ExtensionContext,
  cachedModels: ModelSyncCache | undefined,
): boolean {
  const configuredProviders = SYNC_PROVIDERS.filter(
    (provider) => ctx.modelRegistry.getProviderAuthStatus(provider.id).configured,
  );
  if (configuredProviders.length === 0) return false;

  const hasStaleProvider = configuredProviders.some((provider) => {
    const cachedProvider = cachedModels?.providers[provider.id];
    return (
      !isCachedProviderUsable(cachedProvider, providerBaseUrl(ctx, provider)) ||
      isCacheStale(cachedProvider.fetchedAt)
    );
  });
  if (hasStaleProvider) return true;

  const needsModelsDev = configuredProviders.some((provider) => provider.modelsDevId);
  return needsModelsDev && isCacheStale(cachedModels?.modelsDev?.fetchedAt);
}

function startBackgroundSync(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (inFlightSync) return;
  if (ctx.hasUI) ctx.ui.setStatus("model-sync", "model-sync: syncing…");

  void runSync(pi, ctx, false)
    .then((report) => {
      if (ctx.hasUI && report.attemptedCount > 0 && report.successfulCount === 0) {
        ctx.ui.notify("model-sync: all providers failed", "warning");
      }
    })
    .finally(() => {
      if (ctx.hasUI) ctx.ui.setStatus("model-sync", undefined);
    });
}

function runSync(pi: ExtensionAPI, ctx: ExtensionContext, force: boolean): Promise<SyncReport> {
  if (inFlightSync) return inFlightSync;

  inFlightSync = synchronize(pi, ctx, force).finally(() => {
    inFlightSync = undefined;
  });
  return inFlightSync;
}

async function synchronize(pi: ExtensionAPI, ctx: ExtensionContext, force: boolean): Promise<SyncReport> {
  const customModelIds = await readCustomModelIds();
  const warnings = customModelIds.warning ? [customModelIds.warning] : [];
  const resolvedProviders = await resolveProviders(ctx);
  const noAuthResults = resolvedProviders
    .filter(
      (result): result is { provider: SyncProvider; status: "no-auth" } =>
        "status" in result && result.status === "no-auth",
    )
    .map((result): ProviderSyncResult => ({ provider: result.provider.id, status: "no-auth" }));
  const authFailures = resolvedProviders
    .filter(
      (result): result is { provider: SyncProvider; status: "failed"; error: string } =>
        "status" in result && result.status === "failed",
    )
    .map(
      (result): ProviderSyncResult => ({
        provider: result.provider.id,
        status: "failed",
        error: result.error,
      }),
    );
  const authenticatedProviders = resolvedProviders.filter(
    (result): result is ResolvedProvider => "apiKey" in result,
  );

  if (authenticatedProviders.length === 0) {
    return {
      providerResults: [...noAuthResults, ...authFailures],
      warnings,
      attemptedCount: 0,
      successfulCount: 0,
    };
  }

  const providersToFetch = force
    ? authenticatedProviders
    : authenticatedProviders.filter((provider) => {
        const cachedProvider = cache?.providers[provider.provider.id];
        return (
          !isCachedProviderUsable(cachedProvider, provider.baseUrl) ||
          isCacheStale(cachedProvider.fetchedAt)
        );
      });
  const refreshModelsDev = force || isCacheStale(cache?.modelsDev?.fetchedAt);
  const modelsDevPromise = refreshModelsDev ? fetchModelsDevProviders() : undefined;
  const endpointResults = await Promise.all(providersToFetch.map(fetchProviderModels));
  const modelsDevResult = modelsDevPromise ? await modelsDevPromise : undefined;
  const existingModels = ctx.modelRegistry.getAll() as unknown as ModelDefinition[];
  const providerResults: ProviderSyncResult[] = [...noAuthResults, ...authFailures];
  const nextCache = cache ?? { version: 1 as const, providers: {} };
  let cacheChanged = false;

  if (modelsDevResult?.ok) {
    nextCache.modelsDev = { fetchedAt: Date.now(), providers: modelsDevResult.providers };
    cacheChanged = true;
  }

  const modelsDevProviders = modelsDevResult?.ok
    ? modelsDevResult.providers
    : cache?.modelsDev?.providers;

  for (const endpointResult of endpointResults) {
    if (endpointResult.ok === false) {
      providerResults.push({
        provider: endpointResult.provider.id,
        status: "failed",
        error: endpointResult.error,
      });
      continue;
    }

    nextCache.providers[endpointResult.provider.id] = {
      baseUrl: endpointResult.baseUrl,
      fetchedAt: Date.now(),
      models: endpointResult.models,
    };
    cacheChanged = true;

    try {
      const providerExistingModels = modelsForProvider(existingModels, endpointResult.provider.id);
      const customModelIdsForProvider =
        customModelIds.idsByProvider.get(endpointResult.provider.id) ?? new Set();
      const models = composeProviderModels({
        provider: endpointResult.provider,
        remoteModels: endpointResult.models,
        existingModels: providerExistingModels,
        customModelIds: customModelIdsForProvider,
        customModelDefinitions: customModelIds.definitionsByProvider.get(
          endpointResult.provider.id,
        ),
        modelsDevProvider: modelsDevProviders?.[endpointResult.provider.modelsDevId ?? ""],
        baseUrl: endpointResult.baseUrl,
      });
      registerModels(pi, endpointResult.provider, models);
      const existingIds = new Set(providerExistingModels.map((model) => model.id));
      const newCount = endpointResult.models.filter((model) => !existingIds.has(model.id)).length;
      providerResults.push({
        provider: endpointResult.provider.id,
        status: "success",
        modelCount: models.length,
        newCount,
      });
    } catch (error) {
      providerResults.push({
        provider: endpointResult.provider.id,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  cache = nextCache;
  if (cacheChanged) {
    try {
      await writeCache(nextCache);
    } catch (error) {
      warnings.push(`cache: ${errorMessage(error)}`);
    }
  }

  if (modelsDevResult?.ok) applyCachedModels(pi, ctx, nextCache, customModelIds);

  const successfulCount = providerResults.filter((result) => result.status === "success").length;
  return {
    providerResults: sortResults(providerResults),
    warnings,
    attemptedCount: providersToFetch.length,
    successfulCount,
  };
}

async function resolveProviders(
  ctx: ExtensionContext,
): Promise<
  Array<
    | ResolvedProvider
    | { provider: SyncProvider; status: "no-auth" }
    | { provider: SyncProvider; status: "failed"; error: string }
  >
> {
  return Promise.all(
    SYNC_PROVIDERS.map(async (provider) => {
      try {
        const auth = await ctx.modelRegistry.getProviderAuth(provider.id);
        if (!auth?.auth.apiKey) return { provider, status: "no-auth" } as const;

        return {
          provider,
          apiKey: auth.auth.apiKey,
          baseUrl: auth.auth.baseUrl ?? providerBaseUrl(ctx, provider),
          headers: auth.auth.headers as Record<string, unknown> | undefined,
        };
      } catch (error) {
        return { provider, status: "failed", error: errorMessage(error) } as const;
      }
    }),
  );
}

async function fetchProviderModels(
  resolved: ResolvedProvider,
): Promise<
  | { ok: true; provider: SyncProvider; baseUrl: string; models: RemoteModel[] }
  | { ok: false; provider: SyncProvider; error: string }
> {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(resolved.headers ?? {})) {
      if (typeof value === "string") headers.set(name, value);
    }
    for (const [name, value] of authHeaders(resolved.provider, resolved.apiKey))
      headers.set(name, value);

    const payload = await withTimeout(async (signal) => {
      const response = await fetch(endpointUrl(resolved.provider, resolved.baseUrl), {
        headers,
        signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      return response.json() as Promise<unknown>;
    });
    const models = extractRemoteModels(resolved.provider, payload);
    if (models.length === 0) throw new Error("no chat models returned");

    return { ok: true, provider: resolved.provider, baseUrl: resolved.baseUrl, models };
  } catch (error) {
    return { ok: false, provider: resolved.provider, error: errorMessage(error) };
  }
}

async function fetchModelsDevProviders(): Promise<
  { ok: true; providers: Record<string, ModelsDevProvider> } | { ok: false }
> {
  try {
    const catalog = await withTimeout((signal) => Models.make().providers({ signal }));
    const providers: Record<string, ModelsDevProvider> = {};
    for (const provider of SYNC_PROVIDERS) {
      if (!provider.modelsDevId) continue;
      const metadata = catalog[provider.modelsDevId] as ModelsDevSdkProvider | undefined;
      if (metadata) providers[provider.modelsDevId] = metadata as unknown as ModelsDevProvider;
    }
    return { ok: true, providers };
  } catch {
    return { ok: false };
  }
}

async function readCustomModelIds(): Promise<CustomModelIds> {
  try {
    const file = await readFile(join(getAgentDir(), "models.json"), "utf8");
    const parsed = JSON.parse(file) as unknown;
    const providers = asRecord(asRecord(parsed)?.providers);
    const idsByProvider = new Map<string, Set<string>>();
    const definitionsByProvider = new Map<string, Map<string, CustomModelDefinition>>();

    for (const [providerId, providerConfig] of Object.entries(providers ?? {})) {
      const models = asArray(asRecord(providerConfig)?.models) ?? [];
      const definitions = new Map<string, CustomModelDefinition>();
      for (const model of models) {
        const rawModel = asRecord(model);
        const id = rawModel?.id;
        if (typeof id !== "string") continue;
        definitions.set(id, customModelDefinition(rawModel));
      }
      if (definitions.size === 0) continue;
      idsByProvider.set(providerId, new Set(definitions.keys()));
      definitionsByProvider.set(providerId, definitions);
    }

    return { idsByProvider, definitionsByProvider };
  } catch (error) {
    const emptyCustomModels = { idsByProvider: new Map(), definitionsByProvider: new Map() };
    if (isMissingFile(error)) return emptyCustomModels;
    return { ...emptyCustomModels, warning: `models.json: ${errorMessage(error)}` };
  }
}

async function loadCache(): Promise<{ cache?: ModelSyncCache }> {
  try {
    const file = await readFile(cachePath(), "utf8");
    return { cache: parseCache(JSON.parse(file)) };
  } catch {
    return {};
  }
}

async function writeCache(nextCache: ModelSyncCache): Promise<void> {
  const targetPath = cachePath();
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });

  try {
    await writeFile(temporaryPath, JSON.stringify(nextCache), "utf8");
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function registerModels(pi: ExtensionAPI, provider: SyncProvider, models: ModelDefinition[]): void {
  pi.registerProvider(provider.id, {
    models: models as NonNullable<ProviderConfig["models"]>,
  });
}

function providerBaseUrl(ctx: ExtensionContext, provider: SyncProvider): string {
  return ctx.modelRegistry.getProvider(provider.id)?.baseUrl ?? provider.defaultBaseUrl;
}

function modelsForProvider(models: ModelDefinition[], providerId: string): ModelDefinition[] {
  return models.filter((model) => model.provider === providerId);
}

function formatReport(report: SyncReport): string {
  const lines = [
    ...report.warnings.map((warning) => `! ${warning}`),
    ...report.providerResults.map((result) => {
      if (result.status === "success") {
        return `✓ ${result.provider}: ${result.modelCount} models (${result.newCount} new)`;
      }
      if (result.status === "no-auth") return `- ${result.provider}: no auth`;
      return `✗ ${result.provider}: ${result.error}`;
    }),
  ];
  return lines.join("\n") || "model-sync: no providers";
}

function sortResults(results: ProviderSyncResult[]): ProviderSyncResult[] {
  const positions = new Map(SYNC_PROVIDERS.map((provider, index) => [provider.id, index]));
  return [...results].sort(
    (left, right) => (positions.get(left.provider) ?? 0) - (positions.get(right.provider) ?? 0),
  );
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

function cachePath(): string {
  return join(getAgentDir(), "model-sync-cache.json");
}

function customModelDefinition(rawModel: Record<string, unknown>): CustomModelDefinition {
  const definition: CustomModelDefinition = {};
  if (typeof rawModel.name === "string") definition.name = rawModel.name;
  if (typeof rawModel.api === "string")
    definition.api = rawModel.api as CustomModelDefinition["api"];
  if (typeof rawModel.baseUrl === "string") definition.baseUrl = rawModel.baseUrl;
  if (typeof rawModel.reasoning === "boolean") definition.reasoning = rawModel.reasoning;
  if (typeof rawModel.contextWindow === "number") definition.contextWindow = rawModel.contextWindow;
  if (typeof rawModel.maxTokens === "number") definition.maxTokens = rawModel.maxTokens;

  const input = asArray(rawModel.input)?.filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  if (input?.length) definition.input = input;

  const rawCost = asRecord(rawModel.cost);
  const cost = {
    ...(finiteNumber(rawCost?.input) !== undefined ? { input: finiteNumber(rawCost?.input) } : {}),
    ...(finiteNumber(rawCost?.output) !== undefined
      ? { output: finiteNumber(rawCost?.output) }
      : {}),
    ...(finiteNumber(rawCost?.cacheRead) !== undefined
      ? { cacheRead: finiteNumber(rawCost?.cacheRead) }
      : {}),
    ...(finiteNumber(rawCost?.cacheWrite) !== undefined
      ? { cacheWrite: finiteNumber(rawCost?.cacheWrite) }
      : {}),
  };
  if (Object.keys(cost).length > 0) definition.cost = cost;

  const samplingParams = asRecord(rawModel.samplingParams);
  if (samplingParams) definition.samplingParams = samplingParams;
  if (rawModel.thinkingLevelMap !== undefined)
    definition.thinkingLevelMap = rawModel.thinkingLevelMap;
  if (rawModel.compat !== undefined) definition.compat = rawModel.compat;
  return definition;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
