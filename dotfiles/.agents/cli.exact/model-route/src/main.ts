import { readFileSync } from "node:fs";
import { urgencyOf, isCandidateInput, type CandidateInput, type CandidateResult } from "./score";
import { canonicalUsageProvider, queryUsage } from "./usage";
import { cacheFilePath, loadSnapshot, saveSnapshot } from "./cache";

const USAGE = "usage: model-route score [<file>]";

export interface RunEnv {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => number;
  isStdinTTY?: () => boolean;
  queryUsage?: typeof queryUsage;
  loadSnapshot?: typeof loadSnapshot;
  saveSnapshot?: typeof saveSnapshot;
  cachePath?: string;
}

export class InputError extends Error {}

export async function run(argv: string[], env: RunEnv = {}): Promise<number> {
  const stdout = env.stdout ?? console.log;
  const stderr = env.stderr ?? console.error;

  let file: string | undefined;
  try {
    file = parseArgs(argv);
  } catch (error) {
    stderr(`model-route: ${errorMessage(error)}`);
    stderr(USAGE);
    return 2;
  }

  let candidates: CandidateInput[];
  try {
    if (file === undefined && (env.isStdinTTY ?? (() => process.stdin.isTTY === true))()) {
      stderr("model-route: refusing to read a terminal as input");
      stderr(USAGE);
      return 2;
    }
    candidates = parseCandidatesInput(readInput(file));
  } catch (error) {
    stderr(`model-route: ${errorMessage(error)}`);
    return 2;
  }

  const scored = await scoreCandidates(candidates, {
    now: env.now ?? Date.now,
    queryUsage: env.queryUsage ?? queryUsage,
    loadSnapshot: env.loadSnapshot ?? loadSnapshot,
    saveSnapshot: env.saveSnapshot ?? saveSnapshot,
    cachePath: env.cachePath ?? cacheFilePath(),
    stderr,
  });
  stdout(`${JSON.stringify(scored, null, 2)}\n`);
  return 0;
}

export async function scoreCandidates(
  candidates: readonly CandidateInput[],
  deps: {
    now: () => number;
    queryUsage: typeof queryUsage;
    loadSnapshot: typeof loadSnapshot;
    saveSnapshot: typeof saveSnapshot;
    cachePath: string;
    stderr: (text: string) => void;
  },
): Promise<CandidateResult[]> {
  const needsUsage = candidates.length > 0;
  const cached = needsUsage ? deps.loadSnapshot(deps.cachePath, deps.now()) : null;
  const fresh = needsUsage && cached === null ? await deps.queryUsage() : null;
  const nowMs = deps.now();
  const states = cached?.states ?? fresh;
  if (fresh !== null) {
    try {
      deps.saveSnapshot(deps.cachePath, { fetchedAt: nowMs, states: fresh });
    } catch (error) {
      deps.stderr(`model-route: cache save failed: ${errorMessage(error)}`);
    }
  }

  return candidates.map((candidate) => {
    const key = canonicalUsageProvider(candidate.provider);
    const state = states?.get(key);
    const validState = state && Date.parse(state.resetsAt) > nowMs ? state : undefined;
    const usageState: CandidateResult["usageState"] = validState
      ? { ...validState, source: cached === null ? "fresh" : "cache" }
      : null;
    const urgency = urgencyOf(validState, nowMs);
    return {
      provider: candidate.provider,
      model: candidate.model,
      urgency,
      usageState,
    };
  });
}

function parseArgs(argv: string[]): string | undefined {
  if (argv[0] !== "score") throw new Error("expected score command");
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
  }
  if (argv.length > 2) throw new Error("at most one input file is allowed");
  return argv[1];
}

function readInput(file: string | undefined): string {
  if (file === undefined) return readFileSync(0, "utf8");
  return readFileSync(file, "utf8");
}

function parseCandidatesInput(source: string): CandidateInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new InputError(`invalid JSON input: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InputError("input must be an object with a candidates array");
  }
  const raw = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(raw)) throw new InputError("input must have a candidates array");
  return raw.map((entry) => {
    if (!isCandidateInput(entry))
      throw new InputError(`invalid candidate: ${JSON.stringify(entry)}`);
    return { provider: entry.provider, model: entry.model };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
