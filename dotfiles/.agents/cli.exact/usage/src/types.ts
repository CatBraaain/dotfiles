export type UsageSemanticsKind = "consumer-subscription" | "api-key" | "project";
export type UsageUnit = "percent" | "usd" | "currency" | "count";
export type UsageDisplayState = "current" | "configured";

export interface UsageSemantics {
  kind: UsageSemanticsKind;
  label: string;
}

export interface UsageBucket {
  id: string;
  label: string;
  groupId?: string;
  groupLabel?: string;
  modelKeys?: string[];
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnit;
  period?: string;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface UsageMetric {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnit;
  currency?: string;
}

export interface UsageReport {
  providerId: string;
  providerName: string;
  capturedAt: number;
  source: string;
  semantics: UsageSemantics;
  accountLabel?: string;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  notes?: string[];
}

export interface ResolvedAuth {
  apiKey?: string;
  headers: Record<string, string>;
  secrets: string[];
}

export interface UsageProviderAdapter {
  id: string;
  displayName: string;
  semantics: UsageSemantics;
  publishesStatusline?: boolean;
  invalidateCacheOnFailure?: boolean;
  query(
    auth: ResolvedAuth,
    signal: AbortSignal,
    timeoutMs: number,
    guard: () => Promise<void>,
  ): Promise<UsageReport>;
}

export type ProviderUsageState =
  | {
      providerId: string;
      providerName: string;
      displayState: UsageDisplayState;
      status: "ready";
      report: UsageReport;
    }
  | {
      providerId: string;
      providerName: string;
      displayState: UsageDisplayState;
      status: "unsupported" | "auth-unavailable" | "query-failed";
      message: string;
    };
