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

export function renderUsageTable(
  states: ProviderUsageState[],
  render: (state: ProviderUsageState, nameWidth: number) => string = renderProviderState,
): string {
  if (states.length === 0) return "";
  const nameWidth = Math.max(MIN_NAME_WIDTH, ...states.map((state) => providerName(state).length));
  const header = `${"".padEnd(nameWidth)}  short   long`;
  return [header, ...states.map((state) => render(state, nameWidth))].join("\n");
}

export function renderProviderState(state: ProviderUsageState, nameWidth = MIN_NAME_WIDTH): string {
  const summary = summarizeProviderUsage(state);
  const short = formatRemaining(summary.short);
  const long = formatRemaining(summary.long);
  return `${providerName(state).padEnd(nameWidth)}  ${short.padStart(PERCENT_WIDTH)}  ${long.padStart(PERCENT_WIDTH)}`;
}

function providerName(state: ProviderUsageState): string {
  return PROVIDER_NAMES[state.providerId] ?? sanitizeDisplayText(state.providerName, 80);
}

function formatRemaining(remaining: number | null): string {
  return remaining === null ? "—" : `${remaining}%`;
}
