import { execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, stat } from "node:fs/promises";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { cronMatches } from "./cron.ts";
import type { ModelCandidate, SettingsRule } from "./routing.ts";

const USAGE_TIMEOUT_MS = 25_000;
const FORCE_KILL_DELAY_MS = 5_000;
const EXIT_STDIO_GRACE_MS = 100;
const USAGE_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const execFileAsync = promisify(execFile);

type UsageResult = { exitCode: number; stdout: string };

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
  { platform = process.platform, homeDir = homedir(), cwd = process.cwd() } = {},
): Promise<UsageResult> {
  signal?.throwIfAborted();
  if (platform !== "win32") return runPosixUsage(cwd, signal);

  const command = join(homeDir, ".agents", "cli", "usage.exe");
  const result = await pi.exec(command, ["--json"], {
    signal,
    timeout: USAGE_TIMEOUT_MS,
  });
  signal?.throwIfAborted();
  if (result.killed || ("truncated" in result && result.truncated === true))
    throw new Error("Usage query returned killed or truncated output");
  if (result.code === 1) {
    await access(command);
    signal?.throwIfAborted();
  }
  return { exitCode: result.code, stdout: result.stdout };
}

async function runPosixUsage(cwd: string, signal?: AbortSignal): Promise<UsageResult> {
  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS);
  const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const execution = execFileAsync("usage", ["--json"], {
    cwd,
    signal: runSignal,
    maxBuffer: USAGE_MAX_BUFFER_BYTES,
  });
  const child = execution.child;
  let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined;
  function closeOutputPipes() {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  function limitPipeDrain() {
    pipeDrainTimer = setTimeout(closeOutputPipes, EXIT_STDIO_GRACE_MS);
  }

  child.stdin?.end();
  child.once("exit", limitPipeDrain);
  runSignal.addEventListener("abort", closeOutputPipes, { once: true });
  try {
    const { stdout } = await execution;
    runSignal.throwIfAborted();
    return { exitCode: 0, stdout };
  } catch (error) {
    if (runSignal.aborted || child.killed) {
      await waitForUsageExit(child);
      signal?.throwIfAborted();
      throw new Error("Usage query returned killed or truncated output");
    }
    if (!(error instanceof Error)) throw error;
    const { code, stdout } = error as Error & { code?: string | number; stdout?: string };
    if (code === "ENOENT") {
      const hasWorkingDirectory = await stat(cwd).then(
        (entry) => entry.isDirectory(),
        () => false,
      );
      runSignal.throwIfAborted();
      return { exitCode: hasWorkingDirectory ? COMMAND_NOT_FOUND_EXIT_CODE : 1, stdout: "" };
    }
    if (typeof code === "number") return { exitCode: code, stdout: stdout ?? "" };
    if (child.signalCode)
      return { exitCode: 128 + osConstants.signals[child.signalCode], stdout: stdout ?? "" };
    throw error;
  } finally {
    clearTimeout(pipeDrainTimer);
    child.off("exit", limitPipeDrain);
    runSignal.removeEventListener("abort", closeOutputPipes);
  }
}

async function waitForUsageExit(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const forceKill = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(forceKill);
  }
}
