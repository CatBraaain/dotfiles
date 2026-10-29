import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const execFileAsync = promisify(execFile);

const USAGE_WIDGET_KEY = "provider-usage";
const USAGE_WIDGET_PLACEMENT = "belowEditor" as const;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_CLI_TIMEOUT_MS = 10 * 1000;

export const usageEntrySchema = Type.Object({
  provider: Type.String(),
  short: Type.Union([Type.Number(), Type.Null()]),
  shortResetsAt: Type.Union([Type.String(), Type.Null()]),
  long: Type.Union([Type.Number(), Type.Null()]),
  longResetsAt: Type.Union([Type.String(), Type.Null()]),
});

export type UsageEntry = Static<typeof usageEntrySchema>;

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "codex",
  commandcode: "command",
  zai: "zai",
};

const WINDOW_LABELS = ["short", "long"] as const;
const PERCENT_WIDTH = "100%".length;
const RESET_SEPARATOR = " ↻ ";

const UNAVAILABLE_MESSAGE = "usage-cli unavailable";

export function usageCliPath(): string {
  return join(homedir(), ".agents", "cli", "usage");
}

export function parseUsageJson(stdout: string): UsageEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entriesSchema = Type.Array(usageEntrySchema);
  return Value.Check(entriesSchema, parsed) ? (parsed as UsageEntry[]) : [];
}

export function formatRelativeTime(resetsAt: string, now: number): string {
  const resetsAtMs = Date.parse(resetsAt);
  if (Number.isNaN(resetsAtMs)) return "?";
  const remainingMinutes = Math.ceil((resetsAtMs - now) / 60_000);
  if (remainingMinutes <= 0) return "0m";
  const minutes = remainingMinutes % 60;
  const hours = Math.floor(remainingMinutes / 60) % 24;
  const days = Math.floor(remainingMinutes / (60 * 24));
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (days > 0) return `${days}d${String(hours).padStart(2, "0")}h${paddedMinutes}m`;
  return hours > 0 ? `${hours}h${paddedMinutes}m` : `${minutes}m`;
}

function formatWindow(
  label: (typeof WINDOW_LABELS)[number],
  percent: number | null,
  resetsAt: string | null,
  now: number,
  resetWidth: number,
): string {
  const remaining = (percent === null ? "—" : `${percent}%`).padStart(PERCENT_WIDTH);
  const countdownWidth = resetWidth > 0 ? RESET_SEPARATOR.length + resetWidth : 0;
  const countdown =
    percent === null || resetsAt === null
      ? " ".repeat(countdownWidth)
      : `${RESET_SEPARATOR}${formatRelativeTime(resetsAt, now).padStart(resetWidth)}`;
  return `${label} ${remaining}${countdown}`;
}

export function formatUsageLine(
  entry: UsageEntry,
  now: number,
  columnWidths = { provider: 0, shortReset: 0, longReset: 0 },
): string {
  const provider = PROVIDER_LABELS[entry.provider] ?? entry.provider;
  const providerPadding = " ".repeat(Math.max(0, columnWidths.provider - visibleWidth(provider)));
  const short = formatWindow(
    "short",
    entry.short,
    entry.shortResetsAt,
    now,
    columnWidths.shortReset,
  );
  const long = formatWindow("long", entry.long, entry.longResetsAt, now, columnWidths.longReset);
  return `${provider}${providerPadding} | ${short} | ${long}`.trimEnd();
}

export function buildUsageWidgetLines(entries: UsageEntry[], now: number): string[] | undefined {
  if (entries.length === 0) return undefined;
  const providerWidth = Math.max(
    ...entries.map((entry) => visibleWidth(PROVIDER_LABELS[entry.provider] ?? entry.provider)),
  );
  const columnWidths = {
    provider: providerWidth,
    shortReset: resetColumnWidth(entries, "short", now),
    longReset: resetColumnWidth(entries, "long", now),
  };
  return entries.map((entry) => formatUsageLine(entry, now, columnWidths));
}

function resetColumnWidth(
  entries: UsageEntry[],
  label: (typeof WINDOW_LABELS)[number],
  now: number,
): number {
  return Math.max(
    0,
    ...entries.map((entry) => {
      const resetsAt = entry[`${label}ResetsAt`];
      return entry[label] === null || resetsAt === null
        ? 0
        : formatRelativeTime(resetsAt, now).length;
    }),
  );
}

async function fetchUsageEntries(): Promise<UsageEntry[]> {
  const { stdout } = await execFileAsync(usageCliPath(), ["--json"], {
    timeout: USAGE_CLI_TIMEOUT_MS,
    encoding: "utf8",
  });
  return parseUsageJson(stdout);
}

function setUsageWidget(ctx: ExtensionContext, lines: string[]): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    USAGE_WIDGET_KEY,
    (_ui, theme) => ({
      render: (width) => lines.map((line) => truncateToWidth(theme.fg("dim", line), width)),
      invalidate: () => {},
    }),
    { placement: USAGE_WIDGET_PLACEMENT },
  );
}

function removeUsageWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined, { placement: USAGE_WIDGET_PLACEMENT });
}

async function refreshUsageWidget(
  ctx: ExtensionContext,
  fetchEntries: () => Promise<UsageEntry[]>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  try {
    const entries = await fetchEntries();
    if (signal.aborted) return;
    const lines = buildUsageWidgetLines(entries, Date.now());
    if (lines === undefined) {
      removeUsageWidget(ctx);
      return;
    }
    setUsageWidget(ctx, lines);
  } catch {
    if (signal.aborted) return;
    setUsageWidget(ctx, [UNAVAILABLE_MESSAGE]);
  }
}

export default function providerUsageExtension(
  pi: ExtensionAPI,
  fetchEntries: () => Promise<UsageEntry[]> = fetchUsageEntries,
): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshController: AbortController | undefined;

  function stopRefreshing(): void {
    refreshController?.abort();
    refreshController = undefined;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    stopRefreshing();
    const controller = new AbortController();
    refreshController = controller;
    void refreshUsageWidget(ctx, fetchEntries, controller.signal);
    refreshTimer = setInterval(
      () => void refreshUsageWidget(ctx, fetchEntries, controller.signal),
      REFRESH_INTERVAL_MS,
    );
  });

  pi.on("session_shutdown", stopRefreshing);
}
