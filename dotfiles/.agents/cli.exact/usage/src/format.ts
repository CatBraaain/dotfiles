import type { ProviderUsageState, UsageBucket, UsageDisplayState, UsageReport } from "./types";
import { sanitizeDisplayText } from "./util";

const BAR_SEGMENTS = 20;
const VALUE_COLUMN = 29;

export function formatUsageReport(report: UsageReport, displayState: UsageDisplayState): string {
  const stateLabel = displayState === "current" ? "Current" : "Configured";
  const title = `${report.providerName} Usage`;
  const lines = [`${title} · ${stateLabel}`];
  if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
  lines.push(`Semantics: ${report.semantics.label}`, "");

  if (report.providerId === "openai-codex") formatCodexReport(lines, report);
  else if (report.providerId === "command-code") formatCommandCodeReport(lines, report);
  else if (report.providerId === "zai") formatZaiReport(lines, report);
  else formatGenericReport(lines, report);

  if (report.notes) {
    for (const note of report.notes) lines.push(note);
  }
  return lines.join("\n").trimEnd();
}

function formatCodexReport(lines: string[], report: UsageReport): void {
  let previousGroup: string | undefined;
  for (const bucket of report.buckets) {
    const group = bucket.groupId ?? bucket.id;
    if (group !== previousGroup && group !== "codex") {
      lines.push(`${bucket.groupLabel ?? group} limit:`);
    }
    previousGroup = group;
    const fallback = bucket.id.endsWith(":secondary") ? "weekly" : "5h";
    const label = `${formatWindowLabel(bucket.windowMinutes, fallback, false)} limit:`;
    lines.push(`${label.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
  }
  for (const metric of report.metrics) {
    if (metric.id === "reset-credits") {
      lines.push(`${"Usage limit resets:".padEnd(VALUE_COLUMN)}${metric.value} available`);
    } else if (metric.id === "credits") {
      lines.push(
        `${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
      );
    }
  }
}

function percentRemaining(bucket: UsageBucket): number {
  if (!bucket.limit || bucket.remaining === undefined) return 0;
  return Math.round(clampPercent((bucket.remaining / bucket.limit) * 100));
}

function formatCommandCodeReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    if (bucket.used === undefined || bucket.limit === undefined) {
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}unavailable${reset}`);
      continue;
    }
    lines.push(
      `${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatUsd(bucket.used)} of ${formatUsd(bucket.limit)} used · ${percentRemaining(bucket)}% left${reset}`,
    );
  }
  for (const metric of report.metrics) {
    lines.push(
      `${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
    );
  }
}

function formatZaiReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    if (bucket.unit === "percent" && bucket.used !== undefined) {
      lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
      continue;
    }
    const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
    let value = "unavailable";
    if (bucket.used !== undefined && bucket.limit !== undefined) {
      value = `${bucket.used} of ${bucket.limit} used`;
      if (bucket.remaining !== undefined) value += ` · ${bucket.remaining} left`;
    } else if (bucket.used !== undefined) {
      value = `${bucket.used} used`;
    } else if (bucket.remaining !== undefined) {
      value = `${bucket.remaining} left`;
    }
    lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}${reset}`);
  }
  for (const metric of report.metrics) {
    lines.push(
      `${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
    );
  }
}

function formatGenericReport(lines: string[], report: UsageReport): void {
  for (const bucket of report.buckets) {
    lines.push(
      `${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit)}`,
    );
  }
  for (const metric of report.metrics) {
    lines.push(
      `${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
    );
  }
}

function formatPercentBucket(bucket: UsageBucket): string {
  return `${formatPercentBar(bucket)}${bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : ""}`;
}

function formatPercentBar(bucket: UsageBucket): string {
  const remaining = clampPercent(bucket.remaining ?? 0);
  const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}] ${remaining.toFixed(0)}% left`;
}

function formatWindowLabel(
  minutes: number | undefined,
  fallback: "5h" | "weekly",
  compact: boolean,
): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
    return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
  }
  if (minutes === 10_080) return compact ? "wk" : "Weekly";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatMetricValue(value: number | string, unit: UsageBucket["unit"] | undefined): string {
  if (unit === "usd" && typeof value === "number") return formatUsd(value);
  if (unit === "percent" && typeof value === "number") return `${value}%`;
  return String(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset.getMinutes().toString().padStart(2, "0")}`;
  const now = new Date();
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function renderProviderState(state: ProviderUsageState): string {
  if (state.status === "ready") return formatUsageReport(state.report, state.displayState);
  const label = state.displayState === "current" ? "Current" : "Configured";
  const status =
    state.status === "auth-unavailable"
      ? "Authentication unavailable"
      : state.status === "unsupported"
        ? "Unsupported"
        : "Query failed";
  return `${sanitizeDisplayText(state.providerName, 80)} · ${label} · ${status}: ${sanitizeDisplayText(state.message, 600)}`;
}
