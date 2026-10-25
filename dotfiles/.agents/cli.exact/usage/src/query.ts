import type { AuthResolution } from "./auth";
import type {
  ProviderUsageState,
  ResolvedAuth,
  UsageDisplayState,
  UsageProviderAdapter,
} from "./types";
import { errorMessage, redactUsageError, runWithConcurrency } from "./util";

const QUERY_TIMEOUT_MS = 15_000;
const QUERY_CONCURRENCY = 2;

export interface QueryOptions {
  resolveAuth: (providerId: string) => AuthResolution | Promise<AuthResolution>;
  displayState: (providerId: string) => UsageDisplayState;
}

export async function queryProviders(
  adapters: readonly UsageProviderAdapter[],
  options: QueryOptions,
): Promise<ProviderUsageState[]> {
  const controller = new AbortController();
  const results = await runWithConcurrency(
    adapters,
    QUERY_CONCURRENCY,
    async (adapter, _index, signal): Promise<ProviderUsageState> => {
      const base = {
        providerId: adapter.id,
        providerName: adapter.displayName,
        displayState: options.displayState(adapter.id),
      };
      let auth: ResolvedAuth | undefined;
      try {
        const resolution = await options.resolveAuth(adapter.id);
        if (resolution.status === "unavailable") {
          return {
            ...base,
            status: "auth-unavailable",
            message: redactUsageError(resolution.message),
          };
        }
        auth = resolution.auth;
        const report = await adapter.query(auth, signal, QUERY_TIMEOUT_MS, async () => {});
        return redactReportStrings({ ...base, status: "ready", report }, auth.secrets);
      } catch (error) {
        return {
          ...base,
          status: "query-failed",
          message: errorMessage(error, auth?.secrets),
        };
      }
    },
    controller.signal,
  );
  const states = results.map((result, index): ProviderUsageState => {
    if (result.status === "fulfilled") return result.value;
    const adapter = adapters[index]!;
    return {
      providerId: adapter.id,
      providerName: adapter.displayName,
      displayState: "configured",
      status: "query-failed",
      message: errorMessage(result.reason),
    };
  });
  return [
    ...states.filter((state) => state.displayState === "current"),
    ...states.filter((state) => state.displayState !== "current"),
  ];
}

function redactReportStrings<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactUsageError(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactReportStrings(item, secrets)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, redactReportStrings(field, secrets)]),
    ) as T;
  }
  return value;
}
