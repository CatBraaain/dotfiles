import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cronMatches } from "./cron.ts";
import type { ModelCandidate, SettingsRule } from "./routing.ts";

const USAGE_TIMEOUT_MS = 25_000;

const usageRowSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  short: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()])),
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
    parsed.map(({ provider, short, long, longResetsAt, longWindowMinutes }) => [
      provider,
      { ...(short === undefined ? {} : { short }), long, longResetsAt, longWindowMinutes },
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
  pi: Pick<ExtensionAPI, "exec">,
  signal?: AbortSignal,
  { platform = process.platform, homeDir = homedir() } = {},
): Promise<{ exitCode: number; stdout: string }> {
  signal?.throwIfAborted();
  const isWindows = platform === "win32";
  const command = isWindows ? join(homeDir, ".agents", "cli", "usage.exe") : "bash";
  const args = isWindows ? ["--json"] : ["-c", "exec usage --json"];
  const result = await pi.exec(command, args, {
    signal,
    timeout: USAGE_TIMEOUT_MS,
  });
  signal?.throwIfAborted();
  if (result.killed || ("truncated" in result && result.truncated === true))
    throw new Error("Usage query returned killed or truncated output");
  if (isWindows && result.code === 1) {
    await access(command);
    signal?.throwIfAborted();
  }
  return { exitCode: result.code, stdout: result.stdout };
}
