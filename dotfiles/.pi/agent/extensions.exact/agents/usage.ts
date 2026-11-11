import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestBackgroundBash } from "../tools/background-bash.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cronMatches } from "./cron.ts";
import type { ModelCandidate, SettingsRule } from "./routing.ts";

const USAGE_TIMEOUT_SECONDS = 25;

const usageRowSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  long: Type.Union([Type.Number(), Type.Null()]),
  longResetsAt: Type.Union([Type.String({ pattern: "(?:Z|[+-]\\d{2}:\\d{2})$" }), Type.Null()]),
  longWindowMinutes: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]),
});
const usageFactsSchema = Type.Array(usageRowSchema);

export type ProviderUsageFacts = Omit<Static<typeof usageRowSchema>, "provider">;

export function parseUsageFacts(stdout: string): Map<string, ProviderUsageFacts> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Value.Check(usageFactsSchema, parsed)) return null;
  const hasInvalidReset = parsed.some(
    ({ longResetsAt }) => longResetsAt !== null && !Number.isFinite(Date.parse(longResetsAt)),
  );
  if (hasInvalidReset) return null;
  return new Map(
    parsed.map(({ provider, long, longResetsAt, longWindowMinutes }) => [
      provider,
      { long, longResetsAt, longWindowMinutes },
    ]),
  );
}

export function scoreCandidates(
  candidates: readonly ModelCandidate[],
  providerUrgency: ReadonlyMap<string, number | null>,
  providerSettings: Readonly<Record<string, readonly SettingsRule[]>>,
  now: Date,
): ModelCandidate[] {
  return candidates
    .map((candidate) => {
      let score = candidate.weight ?? 1;
      const rules = candidate.settings ?? providerSettings[candidate.provider] ?? [];
      for (const rule of rules) {
        if (rule.cron !== undefined && !cronMatches(rule.cron, now)) continue;
        const multiply =
          typeof rule.multiply === "number"
            ? rule.multiply
            : (providerUrgency.get(rule.multiply.provider) ?? 1);
        score *= multiply;
      }
      return { candidate, score };
    })
    .filter(({ score }) => score !== 0)
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);
}

const bashOutputSchema = Type.Object({
  output: Type.String(),
  exit_code: Type.Number(),
  truncated: Type.Boolean(),
});

export async function runUsage(
  context: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string }> {
  const outcome = await requestBackgroundBash({
    id: `agents-usage-${randomUUID()}`,
    params: { command: "usage --json 2>/dev/null", timeout: USAGE_TIMEOUT_SECONDS },
    context,
    signal,
  });
  if (outcome.status !== "completed") {
    const reason = outcome.status === "aborted" ? outcome.reason : outcome.error;
    throw new Error(`Usage query failed: ${String(reason)}`);
  }
  const output = outcome.result.structuredContent;
  if (!Value.Check(bashOutputSchema, output) || output.truncated)
    throw new Error("Usage query returned invalid or truncated Bash output");
  return { exitCode: output.exit_code, stdout: output.output };
}
