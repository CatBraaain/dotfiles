import type { ProviderUsageState, UsageBucket, UsageReport } from "./types";

const MILLISECONDS_PER_SECOND = 1000;
const MINUTES_PER_HOUR = 60;

export interface UsageSummary {
  provider: string;
  short: number | null;
  shortResetsAt: number | null;
  long: number | null;
  longResetsAt: number | null;
}

export function summarizeProviderUsage(state: ProviderUsageState): UsageSummary {
  const windows = state.status === "ready" ? selectWindows(state.report) : undefined;
  return {
    provider: state.providerId,
    short: roundedRemaining(windows?.short),
    shortResetsAt: resetTime(windows?.short),
    long: roundedRemaining(windows?.long),
    longResetsAt: resetTime(windows?.long),
  };
}

export function summarizeProviderUsageJson(state: ProviderUsageState) {
  const summary = summarizeProviderUsage(state);
  return {
    ...summary,
    longWindowMinutes:
      state.status === "ready" ? (selectWindows(state.report).long?.windowMinutes ?? null) : null,
    shortResetsAt: formatLocalDateTime(summary.shortResetsAt),
    longResetsAt: formatLocalDateTime(summary.longResetsAt),
  };
}

function formatLocalDateTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * MILLISECONDS_PER_SECOND);
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getFullYear()).padStart(4, "0");
  const [month, day, hour, minute, second] = [
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((part) => String(part).padStart(2, "0"));
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / MINUTES_PER_HOUR)).padStart(
    2,
    "0",
  );
  const offsetRemainder = String(Math.abs(offsetMinutes) % MINUTES_PER_HOUR).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetRemainder}`;
}

function resetTime(bucket: UsageBucket | undefined): number | null {
  const resetsAt = bucket?.resetsAt;
  return resetsAt !== undefined && Number.isFinite(resetsAt) ? resetsAt : null;
}

function roundedRemaining(bucket: UsageBucket | undefined): number | null {
  const remaining = bucket ? remainingPercent(bucket) : undefined;
  return remaining === undefined ? null : Number(remaining.toFixed(0));
}

function selectWindows(report: UsageReport): { long?: UsageBucket; short?: UsageBucket } {
  const windows = report.buckets.filter((bucket) => {
    const isSupplementary = report.providerId === "zai" && bucket.id === "mcp-monthly";
    return !isSupplementary && isPositiveFinite(bucket.windowMinutes);
  });
  const [long] = windows.toSorted((left, right) => right.windowMinutes! - left.windowMinutes!);
  const shortPrefersLowestRemaining = report.providerId === "command-code";
  const [short] = windows
    .filter((bucket) => bucket !== long)
    .flatMap((bucket) => {
      const remaining = remainingPercent(bucket);
      return remaining === undefined ? [] : [{ bucket, remaining }];
    })
    .toSorted((left, right) =>
      shortPrefersLowestRemaining
        ? left.remaining - right.remaining
        : right.remaining - left.remaining,
    );
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
