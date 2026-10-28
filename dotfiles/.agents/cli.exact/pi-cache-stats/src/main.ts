import { parseArgs } from "node:util";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  aggregate,
  collectSessionPairs,
  keysByCountDesc,
  parseBinEdgesMin,
  renderTable,
  type Pair,
  type SessionEntry,
} from "./stats";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_TOP_MODELS = 12;

const CSV_FIELDNAMES = [
  "provider",
  "model",
  "session",
  "timestamp",
  "gap_minutes",
  "input",
  "cache_read",
  "total_tokens",
  "hit_rate",
] as const;

const USAGE = `usage: pi-cache-stats [-n N] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                      [-p PREFIX] [-m PATTERN] [--bins MIN[,MIN...]] [--top N] [--csv PATH]

Measure prompt-cache lifetime per provider/model from pi session files.
For each assistant response, the gap to the previous response with the same
provider+model in the same session is bucketed, and the cache hit rate
(cacheRead / (input + cacheRead)) is averaged per bucket.`;

interface CliOptions {
  limit: number | null;
  since: string | undefined;
  until: string | undefined;
  project: string | undefined;
  model: string | undefined;
  binEdgesMin: number[];
  top: number;
  csv: string | undefined;
}

interface RunEnv {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function run(argv: readonly string[], env: RunEnv = {}): number {
  const stdout = env.stdout ?? console.log;
  const stderr = env.stderr ?? console.error;
  let options: CliOptions;
  try {
    options = parseCliOptions(argv);
  } catch (error) {
    stderr(`pi-cache-stats: ${errorMessage(error)}`);
    stderr(USAGE);
    return 2;
  }
  try {
    if (options.showHelp) {
      stdout(USAGE);
      return 0;
    }
    const files = listSessionFiles(options);
    if (files.paths.length === 0) throw new Error("no session files matched the given filters");
    const { pairs, compactionSkips } = collectPairsFromFiles(files.paths, options.model);
    if (pairs.length === 0) throw new Error("no consecutive same-model response pairs found in the matched sessions");
    if (options.csv !== undefined) writeFileSync(options.csv, pairsToCsv(pairs));
    stdout(renderReport(files, pairs, compactionSkips, options));
    return 0;
  } catch (error) {
    stderr(`pi-cache-stats: ${errorMessage(error)}`);
    return 1;
  }
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      limit: { type: "string", short: "n" },
      since: { type: "string" },
      until: { type: "string" },
      project: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      bins: { type: "string" },
      top: { type: "string" },
      csv: { type: "string" },
    },
  });
  return {
    showHelp: values.help === true,
    limit: parsePositiveInt(values.limit, "-n/--limit"),
    since: values.since,
    until: values.until,
    project: values.project,
    model: values.model,
    binEdgesMin: parseBinEdgesMin(values.bins),
    top: parsePositiveInt(values.top, "--top") ?? DEFAULT_TOP_MODELS,
    csv: values.csv,
  };
}

function parsePositiveInt(raw: string | undefined, optionName: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${optionName} must be a positive integer: ${raw}`);
  return value;
}

function parseDateMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const dateMs = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(dateMs)) throw new Error(`invalid date (expected YYYY-MM-DD): ${raw}`);
  return dateMs;
}

function listSessionFiles(options: CliOptions): { paths: string[]; mtimesMs: number[] } {
  const sinceMs = parseDateMs(options.since);
  const untilMs = parseDateMs(options.until);
  const matched: { mtimeMs: number; path: string }[] = [];
  for (const dirEntry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) continue;
    if (options.project !== undefined && !dirEntry.name.includes(options.project)) continue;
    const dirPath = join(SESSIONS_ROOT, dirEntry.name);
    for (const fileName of readdirSync(dirPath)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const path = join(dirPath, fileName);
      const mtimeMs = statSync(path).mtimeMs;
      if (sinceMs !== null && mtimeMs < sinceMs) continue;
      if (untilMs !== null && mtimeMs >= untilMs) continue;
      matched.push({ mtimeMs, path });
    }
  }
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = options.limit !== null ? matched.slice(0, options.limit) : matched;
  return {
    paths: limited.map((entry) => entry.path),
    mtimesMs: limited.map((entry) => entry.mtimeMs),
  };
}

function collectPairsFromFiles(
  paths: readonly string[],
  modelPattern: string | undefined,
): { pairs: Pair[]; compactionSkips: number } {
  const pairs: Pair[] = [];
  let compactionSkips = 0;
  for (const path of paths) {
    const entries = loadSessionEntries(path);
    if (entries === null) continue;
    const sessionName = basename(dirname(path));
    const result = collectSessionPairs(entries, sessionName, modelPattern);
    for (const pair of result.pairs) pairs.push(pair);
    compactionSkips += result.compactionSkips;
  }
  return { pairs, compactionSkips };
}

function loadSessionEntries(path: string): SessionEntry[] | null {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEntry);
  } catch {
    return null;
  }
}

function renderReport(
  files: { paths: readonly string[]; mtimesMs: readonly number[] },
  pairs: readonly Pair[],
  compactionSkips: number,
  options: CliOptions,
): string {
  const oldestDate = new Date(Math.min(...files.mtimesMs)).toISOString().slice(0, 10);
  const newestDate = new Date(Math.max(...files.mtimesMs)).toISOString().slice(0, 10);
  const lines = [
    `sessions analyzed: ${files.paths.length}, period (file mtime): ${oldestDate} .. ${newestDate}`,
    `pair samples: ${pairs.length} consecutive same provider+model responses (skipped by compaction: ${compactionSkips})`,
    "hit rate = cacheRead / (input + cacheRead), averaged per gap-to-previous-response bucket",
    "",
    "per provider (all models merged):",
    renderTable(aggregate(pairs, options.binEdgesMin, (pair) => pair.provider), options.binEdgesMin),
    "",
    renderModelTable(pairs, options),
  ];
  if (options.csv !== undefined) lines.push("", `per-pair data written: ${options.csv}`);
  return lines.join("\n");
}

function renderModelTable(pairs: readonly Pair[], options: CliOptions): string {
  const modelTable = aggregate(pairs, options.binEdgesMin, (pair) => `${pair.provider}/${pair.model}`);
  const topKeys = keysByCountDesc(modelTable.pairCountByKey).slice(0, options.top);
  const limitedTable = {
    hitRatesByKey: new Map(topKeys.map((key) => [key, modelTable.hitRatesByKey.get(key) ?? []])),
    pairCountByKey: new Map(topKeys.map((key) => [key, modelTable.pairCountByKey.get(key) ?? 0])),
  };
  return `top ${topKeys.length} models:\n${renderTable(limitedTable, options.binEdgesMin)}`;
}

function pairsToCsv(pairs: readonly Pair[]): string {
  const lines = [CSV_FIELDNAMES.join(",")];
  for (const pair of pairs) {
    const fields = pairToCsvFields(pair);
    lines.push(CSV_FIELDNAMES.map((name) => csvEscape(fields[name])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function pairToCsvFields(pair: Pair): Record<(typeof CSV_FIELDNAMES)[number], string | number> {
  return {
    provider: pair.provider,
    model: pair.model,
    session: pair.session,
    timestamp: pair.timestampIso,
    gap_minutes: pair.gapMinutes,
    input: pair.input,
    cache_read: pair.cacheRead,
    total_tokens: pair.totalTokens,
    hit_rate: pair.hitRate,
  };
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const startedMs = Date.now();
  const exitCode = run(process.argv.slice(2));
  console.error(`\nelapsed: ${((Date.now() - startedMs) / 1000).toFixed(1)}s`);
  process.exit(exitCode);
}
