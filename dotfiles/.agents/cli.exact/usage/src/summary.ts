import type { ProviderUsageState, UsageBucket, UsageReport } from "./types";

export interface UsageSummary {
  provider: string;
  short: number | null;
  long: number | null;
}

export function summarizeProviderUsage(state: ProviderUsageState): UsageSummary {
  const windows = state.status === "ready" ? selectWindows(state.report) : undefined;
  return {
    provider: state.providerId,
    short: roundedRemaining(windows?.short),
    long: roundedRemaining(windows?.long),
  };
}

function roundedRemaining(bucket: UsageBucket | undefined): number | null {
  const remaining = bucket ? remainingPercent(bucket) : undefined;
  return remaining === undefined ? null : Number(remaining.toFixed(0));
}

function selectWindows(report: UsageReport): { long?: UsageBucket; short?: UsageBucket } {
  const windows = report.buckets.filter((bucket) => {
    const isSupplementary =
      (report.providerId === "command-code" && bucket.id === "monthly") ||
      (report.providerId === "zai" && bucket.id === "mcp-monthly");
    return !isSupplementary && isPositiveFinite(bucket.windowMinutes);
  });
  const [long] = windows.toSorted((left, right) => right.windowMinutes! - left.windowMinutes!);
  const [short] = windows
    .filter((bucket) => bucket !== long)
    .flatMap((bucket) => {
      const remaining = remainingPercent(bucket);
      return remaining === undefined ? [] : [{ bucket, remaining }];
    })
    .toSorted((left, right) => right.remaining - left.remaining);
  return { long, short: short?.bucket };
}

function remainingPercent(bucket: UsageBucket): number | undefined {
  const limit = bucket.unit === "percent" ? 100 : bucket.limit;
  if (!isPositiveFinite(limit)) return undefined;
  const remaining = Number.isFinite(bucket.remaining)
    ? bucket.remaining
    : Number.isFinite(bucket.used)
      ? limit - bucket.used!
      : undefined;
  if (remaining === undefined) return undefined;
  return Math.min(100, Math.max(0, (remaining / limit) * 100));
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
