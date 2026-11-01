import { execFile } from "node:child_process";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cronMatches } from "./cron.ts";
import type { ModelCandidate, SettingsRule } from "./routing.ts";

const USAGE_TIMEOUT_MS = 25_000;

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

export async function runUsage(
  signal?: AbortSignal,
  execute: typeof execFile = execFile,
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    execute(
      "usage",
      ["--json"],
      {
        encoding: "utf8",
        signal,
        timeout: USAGE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error === null) resolve({ exitCode: 0, stdout });
        else if (error.code === "ENOENT") resolve({ exitCode: 127, stdout: "" });
        else if (typeof error.code === "number") resolve({ exitCode: error.code, stdout });
        else reject(error);
      },
    );
  });
}
