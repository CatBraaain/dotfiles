import { spawn } from "node:child_process";
import type { UsageState } from "./score";

export interface UsageJsonRow {
  provider: string;
  short: number | null;
  shortResetsAt: string | null;
  long: number | null;
  longResetsAt: string | null;
  longWindowMinutes: number | null;
}

const PROVIDER_ALIASES: Record<string, string> = {
  commandcode: "command-code",
};

export function canonicalUsageProvider(providerId: string): string {
  return PROVIDER_ALIASES[providerId] ?? providerId;
}

const DEFAULT_USAGE_TIMEOUT_MS = 20_000;

export async function queryUsage(
  options: { timeoutMs?: number } = {},
): Promise<Map<string, UsageState> | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  let stdoutText = "";
  try {
    const exitCode = await new Promise<number | null>((resolveChild, rejectChild) => {
      const child = spawn("usage", ["--json"], { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectChild(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutText += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveChild(code);
      });
    });
    if (exitCode !== 0) return null;
    const parsed = JSON.parse(stdoutText) as unknown;
    return extractUsageStates(parsed);
  } catch {
    return null;
  }
}

export function extractUsageStates(parsed: unknown): Map<string, UsageState> | null {
  if (!Array.isArray(parsed)) return null;
  const states = new Map<string, UsageState>();
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const { provider, long, longResetsAt, longWindowMinutes } = record;
    if (typeof provider !== "string" || provider === "") continue;
    if (typeof long !== "number" || !Number.isFinite(long) || long < 0 || long > 100) continue;
    if (typeof longResetsAt !== "string" || longResetsAt === "") continue;
    if (!Number.isFinite(Date.parse(longResetsAt))) continue;
    const windowMinutes =
      typeof longWindowMinutes === "number" &&
      Number.isFinite(longWindowMinutes) &&
      longWindowMinutes > 0
        ? longWindowMinutes
        : null;
    states.set(canonicalUsageProvider(provider), {
      remaining: long,
      resetsAt: longResetsAt,
      windowMinutes,
    });
  }
  return states;
}
