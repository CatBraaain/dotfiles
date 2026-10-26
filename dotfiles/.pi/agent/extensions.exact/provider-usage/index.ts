import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
  "command-code": "command",
  zai: "zai",
};

const WINDOW_LABELS = ["short", "long"] as const;

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
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

function formatWindow(
  label: (typeof WINDOW_LABELS)[number],
  percent: number | null,
  resetsAt: string | null,
  now: number,
): string {
  if (percent === null) return `${label} —`;
  const countdown = resetsAt === null ? "" : ` ↻ ${formatRelativeTime(resetsAt, now)}`;
  return `${label} ${percent}%${countdown}`;
}

export function formatUsageLine(entry: UsageEntry, now: number): string {
  const provider = PROVIDER_LABELS[entry.provider] ?? entry.provider;
  const short = formatWindow("short", entry.short, entry.shortResetsAt, now);
  const long = formatWindow("long", entry.long, entry.longResetsAt, now);
  return `${provider} ${short} · ${long}`;
}

export function buildUsageWidgetLines(entries: UsageEntry[], now: number): string[] | undefined {
  if (entries.length === 0) return undefined;
  return entries.map((entry) => formatUsageLine(entry, now));
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

async function refreshUsageWidget(ctx: ExtensionContext): Promise<void> {
  try {
    const entries = await fetchUsageEntries();
    const lines = buildUsageWidgetLines(entries, Date.now());
    if (lines === undefined) {
      removeUsageWidget(ctx);
      return;
    }
    setUsageWidget(ctx, lines);
  } catch {
    setUsageWidget(ctx, [UNAVAILABLE_MESSAGE]);
  }
}

export default function providerUsageExtension(pi: ExtensionAPI): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    void refreshUsageWidget(ctx);
    refreshTimer = setInterval(() => void refreshUsageWidget(ctx), REFRESH_INTERVAL_MS);
  });
}
