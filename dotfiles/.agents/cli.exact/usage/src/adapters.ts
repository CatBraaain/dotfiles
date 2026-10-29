import { fetchProviderJson } from "./http";
import { abortError } from "./util";
import type { ResolvedAuth, UsageProviderAdapter, UsageReport } from "./types";
import type {
  ZaiQuotaPayload,
  ZaiSubscriptionPayload,
  ZaiPlanInfo,
  CodexBackendPayload,
  CommandCodeAccountPayload,
  CommandCodeCreditsPayload,
  CommandCodeSubscriptionPayload,
  CommandCodeUsageSummaryPayload,
  CommandCodeUsageBundle,
} from "./providers/types";
import { normalizeCodexBackendPayload } from "./providers/codex";
import { commandCodeOrgId, normalizeCommandCodeUsagePayload } from "./providers/command-code";
import { normalizeZaiQuotaPayload, normalizeZaiSubscriptionPayload } from "./providers/zai";
import { zaiResponseError } from "./providers/zai-errors";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COMMAND_CODE_API_ORIGIN = "https://api.commandcode.ai";
const COMMAND_CODE_ACCOUNT_URL = `${COMMAND_CODE_API_ORIGIN}/alpha/whoami`;
const COMMAND_CODE_CREDITS_URL = `${COMMAND_CODE_API_ORIGIN}/alpha/billing/credits`;
const COMMAND_CODE_SUBSCRIPTIONS_URL = `${COMMAND_CODE_API_ORIGIN}/alpha/billing/subscriptions`;
const COMMAND_CODE_USAGE_SUMMARY_URL = `${COMMAND_CODE_API_ORIGIN}/alpha/usage/summary`;
export const ADAPTERS: readonly UsageProviderAdapter[] = [
  {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    semantics: {
      kind: "consumer-subscription",
      label: "ChatGPT subscription limits",
    },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(
        CODEX_USAGE_URL,
        auth,
        signal,
        timeoutMs,
        "Codex usage endpoint",
        { redirect: "error" },
      );
      return normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
    },
  },
  {
    id: "commandcode",
    displayName: "Command Code",
    semantics: {
      kind: "consumer-subscription",
      label: "Command Code plan credits and rolling limits",
    },
    async query(auth, signal, timeoutMs, guard) {
      if (!guard) throw new Error("Command Code usage requires request-boundary revalidation.");
      const startedAt = Date.now();
      await guard();
      const account = (await fetchProviderJson(
        COMMAND_CODE_ACCOUNT_URL,
        auth,
        signal,
        remainingTimeout(timeoutMs, startedAt, "fetching the Command Code account"),
        "Command Code account endpoint",
        { redirect: "error" },
      )) as CommandCodeAccountPayload;
      await guard();
      const orgId = commandCodeOrgId(account);
      const [credits, subscription] = await Promise.all([
        fetchCommandCodeOptional(
          commandCodeUrl(COMMAND_CODE_CREDITS_URL, { orgId }),
          auth,
          signal,
          timeoutMs - (Date.now() - startedAt),
          "Command Code credits endpoint",
        ),
        fetchCommandCodeOptional(
          commandCodeUrl(COMMAND_CODE_SUBSCRIPTIONS_URL, { orgId }),
          auth,
          signal,
          timeoutMs - (Date.now() - startedAt),
          "Command Code plan endpoint",
        ),
      ]);
      await guard();
      const usage = await fetchCommandCodeOptional(
        commandCodeUrl(COMMAND_CODE_USAGE_SUMMARY_URL, {
          orgId,
          since: commandCodeSubscriptionStart(subscription),
        }),
        auth,
        signal,
        timeoutMs - (Date.now() - startedAt),
        "Command Code usage summary endpoint",
      );
      await guard();
      if (signal.aborted) throw abortError();

      const bundle: CommandCodeUsageBundle = {
        account,
        ...(credits ? { credits: credits as CommandCodeCreditsPayload } : {}),
        ...(subscription ? { subscription: subscription as CommandCodeSubscriptionPayload } : {}),
        ...(usage ? { usage: usage as CommandCodeUsageSummaryPayload } : {}),
      };
      return normalizeCommandCodeUsagePayload(bundle, Date.now());
    },
  },
  {
    id: "zai",
    displayName: "Z.AI",
    invalidateCacheOnFailure: true,
    semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
    async query(auth, signal, timeoutMs, guard) {
      return queryZaiUsage("zai", "Z.AI", auth, signal, timeoutMs, guard);
    },
  },
];

export function adapterForProvider(providerId: string): UsageProviderAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === providerId);
}

function remainingTimeout(timeoutMs: number, startedAt: number, description: string): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error(`Timed out while ${description}.`);
  return remaining;
}

function zaiMonitorAuth(auth: ResolvedAuth): ResolvedAuth {
  const authorization = headerValue(auth.headers, "Authorization");
  const token =
    authorization === undefined ? undefined : (bearerToken(authorization) ?? authorization);
  if (token === undefined || token === authorization) return auth;
  return { ...auth, headers: { ...auth.headers, Authorization: token } };
}

async function queryZaiUsage(
  providerId: "zai",
  providerName: string,
  auth: ResolvedAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard: () => Promise<void>,
): Promise<UsageReport> {
  if (!guard) throw new Error("Z.AI usage requires request-boundary revalidation.");
  const startedAt = Date.now();
  await guard();
  const payload = (await fetchProviderJson(
    `https://api.z.ai/api/monitor/usage/quota/limit`,
    zaiMonitorAuth(auth),
    signal,
    remainingTimeout(timeoutMs, startedAt, `fetching ${providerName} quota`),
    `${providerName} quota endpoint`,
    { responseError: zaiResponseError, redirect: "error" },
  )) as ZaiQuotaPayload;
  await guard();
  const planTimeoutMs = timeoutMs - (Date.now() - startedAt);
  const plan = await fetchZaiPlan(providerName, auth, signal, planTimeoutMs);
  return normalizeZaiQuotaPayload(providerId, providerName, payload, Date.now(), plan);
}

async function fetchZaiPlan(
  providerName: string,
  auth: ResolvedAuth,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ZaiPlanInfo | undefined> {
  if (timeoutMs <= 0 || signal.aborted) return undefined;
  try {
    const payload = (await fetchProviderJson(
      `https://api.z.ai/api/biz/subscription/list`,
      zaiMonitorAuth(auth),
      signal,
      timeoutMs,
      `${providerName} plan endpoint`,
      { responseError: zaiResponseError, redirect: "error" },
    )) as ZaiSubscriptionPayload;
    return normalizeZaiSubscriptionPayload(payload);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchCommandCodeOptional(
  url: string,
  auth: ResolvedAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
): Promise<Record<string, unknown> | undefined> {
  if (signal.aborted) throw abortError();

  if (timeoutMs <= 0) return undefined;
  try {
    const payload = await fetchProviderJson(url, auth, signal, timeoutMs, description, {
      redirect: "error",
    });
    if (signal.aborted) throw abortError();
    return payload;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function commandCodeUrl(base: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

function commandCodeSubscriptionStart(
  subscription: Record<string, unknown> | undefined,
): string | undefined {
  const data = subscription?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>).currentPeriodStart;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization === undefined ? undefined : /^Bearer\s+(.+)$/iu.exec(authorization)?.[1];
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
