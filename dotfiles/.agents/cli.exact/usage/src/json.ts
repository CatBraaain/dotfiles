import type { ProviderUsageState, UsageBucket, UsageReport } from "./types";

type ReadyState = Extract<ProviderUsageState, { status: "ready" }>;
export type JsonProviderUsageState =
  | Exclude<ProviderUsageState, ReadyState>
  | (Omit<ReadyState, "report"> & {
      report: Omit<UsageReport, "buckets"> & { long: UsageBucket[]; short: UsageBucket[] };
    });

const MONTHLY_COMPARISON_MINUTES = 43_200;

export function toJsonProviderState(state: ProviderUsageState): JsonProviderUsageState {
  if (state.status !== "ready") return state;

  const { buckets, ...report } = state.report;
  const rankedBuckets = buckets.flatMap((bucket) => {
    const duration = comparisonMinutes(report.providerId, bucket);
    return duration === undefined ? [] : [{ bucket, duration }];
  });
  const [longDuration, shortDuration] = [...new Set(rankedBuckets.map((row) => row.duration))].sort(
    (left, right) => right - left,
  );
  return {
    ...state,
    report: {
      ...report,
      long: rankedBuckets.filter((row) => row.duration === longDuration).map((row) => row.bucket),
      short: rankedBuckets.filter((row) => row.duration === shortDuration).map((row) => row.bucket),
    },
  };
}

function comparisonMinutes(providerId: string, bucket: UsageBucket): number | undefined {
  const excluded =
    (providerId === "command-code" && bucket.id === "five-hour") ||
    (providerId === "zai" && bucket.id === "mcp-monthly");
  if (excluded) return undefined;

  const minutes = bucket.windowMinutes;
  if (minutes !== undefined) {
    return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
  }

  const isMonthlyBilling =
    providerId === "command-code" && bucket.id === "monthly" && bucket.period === "billing-period";
  return isMonthlyBilling ? MONTHLY_COMPARISON_MINUTES : undefined;
}
