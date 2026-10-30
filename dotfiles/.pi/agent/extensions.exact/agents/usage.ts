import { execFile } from "node:child_process";
import { cronMatches } from "./cron.ts";
import type { ModelCandidate, SettingsRule } from "./routing.ts";

const USAGE_TIMEOUT_MS = 25_000;

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
