import type { ProviderUsageState } from "./types";
import { summarizeProviderUsage } from "./summary";
import { sanitizeDisplayText } from "./util";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "openai-codex": "Codex",
  "command-code": "Command",
  zai: "Z.AI",
};
const MIN_NAME_WIDTH = 7;
const PERCENT_WIDTH = 5;
const SHORT_RESET_WIDTH = "shortResetsAt".length;
const LONG_RESET_WIDTH = "longResetsAt".length;
const MILLISECONDS_PER_SECOND = 1000;

export function renderUsageTable(
  states: ProviderUsageState[],
  render: (state: ProviderUsageState, nameWidth: number) => string = renderProviderState,
): string {
  if (states.length === 0) return "";
  const nameWidth = Math.max(MIN_NAME_WIDTH, ...states.map((state) => providerName(state).length));
  const header = `${"".padEnd(nameWidth)}  short  shortResetsAt   long  longResetsAt`;
  return [header, ...states.map((state) => render(state, nameWidth))].join("\n");
}

export function renderProviderState(state: ProviderUsageState, nameWidth = MIN_NAME_WIDTH): string {
  const summary = summarizeProviderUsage(state);
  const short = formatRemaining(summary.short);
  const shortResetsAt = formatResetTime(summary.shortResetsAt);
  const long = formatRemaining(summary.long);
  const longResetsAt = formatResetTime(summary.longResetsAt);
  return `${providerName(state).padEnd(nameWidth)}  ${short.padStart(PERCENT_WIDTH)}  ${shortResetsAt.padStart(SHORT_RESET_WIDTH)}  ${long.padStart(PERCENT_WIDTH)}  ${longResetsAt.padStart(LONG_RESET_WIDTH)}`;
}

function formatResetTime(resetsAt: number | null): string {
  if (resetsAt === null) return "—";
  const date = new Date(resetsAt * MILLISECONDS_PER_SECOND);
  if (!Number.isFinite(date.getTime())) return "—";
  const [month, day, hour, minute] = [
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ].map((part) => String(part).padStart(2, "0"));
  return `${month}/${day} ${hour}:${minute}`;
}

function providerName(state: ProviderUsageState): string {
  return PROVIDER_NAMES[state.providerId] ?? sanitizeDisplayText(state.providerName, 80);
}

function formatRemaining(remaining: number | null): string {
  return remaining === null ? "—" : `${remaining}%`;
}
