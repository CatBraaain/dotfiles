// dotfiles-model-sync — host-side port of the pi model-sync extension.
//
// Fetches the current model lineup of every configured pi-ai catalog route
// (models.dev metadata + the provider's own model-listing endpoint) and writes
// the composed entries into settings `llm-pi-ai.providers.<id>.models`, so new
// provider models become usable without waiting for a pi-ai catalog update.
// User-owned entries are preserved; ownership is tracked via the cache's
// `written` section. Pure logic lives in core.ts (unit-tested there).
//
// Types come from the global @deepseek-ai/* install via tsconfig paths; the
// runtime resolves values from the profile closure (everything is
// externalized by the build).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-timer";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-commands";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
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
  parseCache,
  sharedInstalledApi,
  type CachedModelsDev,
  type CachedProvider,
  type InstalledModel,
  type ModelEntry,
  type ModelSyncCache,
  type RemoteModel,
  type ResponseShape,
  type WireApi,
} from "./core.ts";

export const name = "model-sync";
export const inject = ["commands", "settings", "credentials", "timer"];

const MODELS_DEV_URL = "https://models.dev/api.json";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const SETTINGS_CONFLICT_CODE = "SETTINGS_CONFLICT";

/** settings `llm-pi-ai` namespace: structural subset of the resolved section. */
interface PiAiProfile {
  apiKeyEnv?: string;
  api?: string;
  baseURL?: string;
}
type PiAiProviders = Record<string, PiAiProfile & { models?: ModelEntry[] }>;

type SyncStatus = "ok" | "no-auth" | "failed";
interface ProviderOutcome {
  id: string;
  status: SyncStatus;
  total?: number;
  added?: number;
  message?: string;
}

export function apply(ctx: Context) {
  const logger = ctx.logger("model-sync");

  const cachePath = join(
    process.env.DSH_HOME ?? join(homedir(), ".dsh"),
    "model-sync-cache.json",
  );

  ctx.settings.register(
    "model-sync",
    z.object({ disabled: z.boolean().default(false) }),
  );

  const isEnabled = (): boolean => {
    const config = ctx.settings.get("model-sync") as { disabled?: boolean } | undefined;
    return config?.disabled !== true;
  };

  // ---- settings views ---------------------------------------------------------

  const resolvedSection = (): PiAiProviders | undefined =>
    (ctx.settings.get("llm-pi-ai") as { providers?: PiAiProviders } | undefined)?.providers;

  /** Raw user layer plus the revision to guard writes with. */
  const readUserLayer = (): { providers: PiAiProviders; revision: number | undefined } => {
    const descriptor = ctx.settings.describe().find((entry) => entry.ns === "llm-pi-ai");
    const user = (descriptor?.user ?? {}) as { providers?: PiAiProviders };
    return { providers: user.providers ?? {}, revision: descriptor?.revision };
  };

  const resolveApiKey = async (profile: PiAiProfile): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv;
    if (ref === undefined || !isCredentialRefName(ref)) return undefined;
    const resolved = await ctx.credentials.resolve(credentialRef(ref));
    return resolved?.value;
  };

  // ---- cache ------------------------------------------------------------------

  const readCache = async (): Promise<ModelSyncCache> => {
    try {
      const parsed = parseCache(JSON.parse(await readFile(cachePath, "utf8")));
      if (parsed) return parsed;
      logger.warn(`model-sync cache ${cachePath} is invalid; treating it as absent`);
    } catch {
      // Absent or unreadable cache is the documented "no cache" posture.
    }
    return { version: 1, providers: {} };
  };

  const writeCache = async (cache: ModelSyncCache): Promise<void> => {
    const tmpPath = `${cachePath}.tmp-${process.pid}`;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await rename(tmpPath, cachePath);
    } catch (error) {
      logger.warn(`could not write model-sync cache ${cachePath}: ${errorMessage(error)}`);
    }
  };

  // ---- network ------------------------------------------------------------------

  const fetchBounded = async (url: string, headers?: Headers): Promise<unknown> => {
    const finalHeaders = new Headers({ accept: "application/json" });
    if (headers !== undefined) {
      for (const [name, value] of headers) finalHeaders.set(name, value);
    }
    const response = await fetch(url, {
      headers: finalHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new Error(`${url} answered more than 10 MiB`);
    return JSON.parse(body) as unknown;
  };

  const fetchModelsDev = async (): Promise<CachedModelsDev> => ({
    fetchedAt: Date.now(),
    providers: (await fetchBounded(MODELS_DEV_URL)) as CachedModelsDev["providers"],
  });

  const fetchEndpointModels = async (
    url: string,
    api: WireApi | undefined,
    apiKey: string,
  ): Promise<RemoteModel[]> => {
    const shape: ResponseShape = api === "anthropic-messages" ? "anthropic" : "openai";
    const payload = await fetchBounded(url, authHeaders(api, apiKey));
    return extractRemoteModels(shape, payload);
  };

  // ---- sync ---------------------------------------------------------------------

  type SyncPlan = {
    id: string;
    installed: InstalledModel[];
    baseUrl: string;
    api: WireApi | undefined;
    apiKey: string;
    /** Fresh cached listing usable for this sync, refreshed by the fetch phase. */
    cached: CachedProvider | undefined;
  };

  /** pi-ai's typed catalog read, loosened to plain route ids and structural models. */
  const installedCatalogModels = (providerId: string): InstalledModel[] =>
    getBuiltinModels(providerId as never) as unknown as InstalledModel[];

  const buildPlans = async (
    providers: PiAiProviders,
    now: number,
    cache: ModelSyncCache,
    force: boolean,
  ): Promise<{ order: string[]; plans: SyncPlan[]; outcomes: ProviderOutcome[] }> => {
    const catalogIds = new Set<string>(getBuiltinProviders());
    const order: string[] = [];
    const plans: SyncPlan[] = [];
    const outcomes: ProviderOutcome[] = [];
    for (const [id, profile] of Object.entries(providers)) {
      order.push(id);
      if (!catalogIds.has(id)) continue; // hand-declared route: the user defines its models
      const installed = installedCatalogModels(id);
      const baseUrl = profile.baseURL ?? catalogBaseUrl(installed);
      if (!baseUrl) {
        outcomes.push({ id, status: "failed", message: "no baseUrl in profile or catalog" });
        continue;
      }
      const apiKey = await resolveApiKey(profile);
      if (apiKey === undefined) {
        outcomes.push({ id, status: "no-auth" });
        continue;
      }
      const api = (profile.api ?? sharedInstalledApi(installed)) as WireApi | undefined;
      const cachedProvider = cache.providers[id];
      plans.push({
        id,
        installed,
        baseUrl,
        api,
        apiKey,
        cached:
          !force && isCachedProviderUsable(cachedProvider, baseUrl, now)
            ? cachedProvider
            : undefined,
      });
    }
    return { order, plans, outcomes };
  };

  const fetchPlans = async (
    plans: SyncPlan[],
    outcomes: ProviderOutcome[],
    cache: ModelSyncCache,
    force: boolean,
    now: number,
  ): Promise<CachedModelsDev | undefined> => {
    let freshModelsDev: CachedModelsDev | undefined;
    await Promise.all([
      ...plans
        .filter((plan) => plan.cached === undefined)
        .map(async (plan) => {
          try {
            const models = await fetchEndpointModels(
              endpointUrl(plan.api, plan.baseUrl),
              plan.api,
              plan.apiKey,
            );
            if (models.length === 0) throw new Error("the endpoint listed no chat models");
            plan.cached = { baseUrl: plan.baseUrl, fetchedAt: Date.now(), models };
          } catch (error) {
            outcomes.push({ id: plan.id, status: "failed", message: errorMessage(error) });
          }
        }),
      (async () => {
        if (!force && !isCacheStale(cache.modelsDev?.fetchedAt, now)) return;
        try {
          freshModelsDev = await fetchModelsDev();
        } catch {
          // models.dev stays optional: composition continues from cache or defaults.
        }
      })(),
    ]);
    return freshModelsDev;
  };

  /** Compose entries for every planned provider from cache or fetched listings. */
  const composeEntries = (
    plans: SyncPlan[],
    cache: ModelSyncCache,
    modelsDev: CachedModelsDev | undefined,
  ): { composed: Record<string, ModelEntry[]>; stats: Map<string, { total: number; added: number }> } => {
    const { providers: userProviders } = readUserLayer();
    const composed: Record<string, ModelEntry[]> = {};
    const stats = new Map<string, { total: number; added: number }>();
    for (const plan of plans) {
      const remote = plan.cached?.models;
      if (remote === undefined) continue; // failed providers were already reported
      const result = composeProviderModels({
        installed: plan.installed,
        userModels: userProviders[plan.id]?.models,
        previousWritten: cache.written?.[plan.id] ?? [],
        remote,
        modelsDevProvider: modelsDev?.providers?.[plan.id],
        sharedApi: sharedInstalledApi(plan.installed),
      });
      composed[plan.id] = result.entries;
      stats.set(plan.id, { total: result.entries.length, added: result.newIds.length });
      if (deepEqualJson(userProviders[plan.id]?.models ?? null, result.entries)) {
        delete composed[plan.id];
      }
    }
    return { composed, stats };
  };

  const writeComposed = async (
    composed: Record<string, ModelEntry[]>,
    revision: number | undefined,
  ): Promise<{ written: Record<string, ModelEntry[]>; failures: Record<string, string> }> => {
    if (Object.keys(composed).length === 0) return { written: {}, failures: {} };
    const written: Record<string, ModelEntry[]> = {};
    const failures: Record<string, string> = {};
    try {
      await ctx.settings.update("llm-pi-ai", { providers: composed }, revision);
      return { written: composed, failures };
    } catch (error) {
      const conflict = (error as { code?: string }).code === SETTINGS_CONFLICT_CODE;
      if (!conflict) {
        // A schema or serviceability failure names no single provider; retry
        // each provider on its own so one bad model list cannot block the rest.
        for (const [id, entries] of Object.entries(composed)) {
          try {
            await ctx.settings.update("llm-pi-ai", { providers: { [id]: { models: entries } } }, revision);
            written[id] = entries;
          } catch (perProviderError) {
            failures[id] = errorMessage(perProviderError);
          }
        }
        return { written, failures };
      }
      throw error;
    }
  };

  const recordOutcomes = (
    plans: SyncPlan[],
    stats: Map<string, { total: number; added: number }>,
    written: Record<string, ModelEntry[]>,
    failures: Record<string, string>,
    cache: ModelSyncCache,
    outcomeById: Map<string, ProviderOutcome>,
  ): void => {
    for (const [id, entries] of Object.entries(written)) {
      cache.written = { ...cache.written, [id]: entries };
    }
    for (const plan of plans) {
      const stat = stats.get(plan.id);
      if (stat === undefined) continue;
      const failure = failures[plan.id];
      if (failure !== undefined) {
        logger.warn(`llm-pi-ai update for ${plan.id} was rejected; keeping its current models: ${failure}`);
        outcomeById.set(plan.id, { id: plan.id, status: "failed", message: failure });
      } else {
        outcomeById.set(plan.id, {
          id: plan.id,
          status: "ok",
          total: stat.total,
          added: written[plan.id] === undefined ? 0 : stat.added,
        });
      }
    }
  };

  const syncOnce = async (force: boolean): Promise<ProviderOutcome[]> => {
    if (!isEnabled()) return [];

    const providers = resolvedSection() ?? {};
    const cache = await readCache();
    const now = Date.now();
    const { order, plans, outcomes } = await buildPlans(providers, now, cache, force);
    if (plans.length === 0) return orderOutcomes(order, outcomes);

    const freshModelsDev = await fetchPlans(plans, outcomes, cache, force, now);
    const modelsDev = freshModelsDev ?? cache.modelsDev;

    const outcomeById = new Map<string, ProviderOutcome>();
    try {
      const { composed, stats } = composeEntries(plans, cache, modelsDev);
      const { revision } = readUserLayer();
      const { written, failures } = await writeComposed(composed, revision);
      recordOutcomes(plans, stats, written, failures, cache, outcomeById);
    } catch (error) {
      if ((error as { code?: string }).code !== SETTINGS_CONFLICT_CODE) throw error;
      // The namespace moved since we read it: reread, recompose, try once more.
      const { composed, stats } = composeEntries(plans, cache, modelsDev);
      const { revision: freshRevision } = readUserLayer();
      const { written, failures } = await writeComposed(composed, freshRevision);
      recordOutcomes(plans, stats, written, failures, cache, outcomeById);
    }

    for (const outcome of outcomes) outcomeById.set(outcome.id, outcome);
    for (const plan of plans) {
      if (plan.cached !== undefined) cache.providers[plan.id] = plan.cached;
    }
    if (freshModelsDev !== undefined) cache.modelsDev = freshModelsDev;
    await writeCache(cache);
    return orderOutcomes(order, [...outcomeById.values()]);
  };

  /** Report providers in settings declaration order, not completion order. */
  const orderOutcomes = (order: string[], outcomes: ProviderOutcome[]): ProviderOutcome[] => {
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...outcomes].sort(
      (a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
    );
  };

  // ---- command and loop -----------------------------------------------------------

  const modelSyncCommand: CommandDefinition = {
    name: "model-sync",
    description: "Re-sync provider model catalogs (models.dev + endpoints) into llm-pi-ai settings",
    async handler() {
      if (!isEnabled()) return { kind: "success" as const, text: "model-sync: disabled" };
      const outcomes = await syncOnce(true);
      if (outcomes.length === 0) {
        return {
          kind: "success" as const,
          text: "model-sync: no configured pi-ai catalog providers",
        };
      }
      const lines = outcomes.map((outcome) => {
        if (outcome.status === "ok") {
          return `✓ ${outcome.id}: ${outcome.total} models (${outcome.added} new)`;
        }
        if (outcome.status === "no-auth") return `- ${outcome.id}: no auth`;
        return `✗ ${outcome.id}: ${outcome.message ?? "failed"}`;
      });
      return { kind: "success" as const, text: lines.join("\n") };
    },
  };

  const backgroundSync = (): void => {
    void syncOnce(false).catch((error) => {
      logger.warn(`background model sync failed: ${errorMessage(error)}`);
    });
  };

  ctx.effect(
    function* () {
      yield ctx.commands.register(modelSyncCommand);
      yield ctx.interval(backgroundSync, CACHE_TTL_MS);
    },
    "model-sync sync loop",
  );

  backgroundSync();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
