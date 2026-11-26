import { parseArgs } from "node:util";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
import { SESSIONS_ROOT, indexSessionFile, listSessionFiles } from "./scan";
import { StatsDb, defaultDbPath, type UsageEventRecord } from "./db";
import {
  buildSummary,
  renderSummary,
  startOfLocalDay,
  projectOfSession,
  type SummaryOptions,
  type SummarySource,
} from "./summary";

const DEFAULT_TOP = 20;
const DEFAULT_DAYS = 14;

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

const USAGE = `usage:
  pi-stats [gap-analysis options]            measure prompt-cache lifetime (default mode)
  pi-stats stats [stats options]             token/cost/session usage statistics
  pi-stats -h                                show this help

gap-analysis options:
  -n N            newest N sessions by file mtime
  --since DATE    sessions updated on or after this UTC date (YYYY-MM-DD)
  --until DATE    sessions updated before this UTC date (YYYY-MM-DD)
  -p PREFIX       session directories whose name contains PREFIX
  -m PATTERN      provider/model pairs containing PATTERN (case-insensitive)
  --bins MIN,...  gap bucket edges in minutes (default 1,5,15,30,60,180)
  --top N         rows in the model table (default 12)
  --csv PATH      write per-pair raw data to PATH

stats options:
  --since DATE    events on or after this local date (YYYY-MM-DD)
  --until DATE    events before this local date (YYYY-MM-DD)
  -p PREFIX       projects whose name contains PREFIX
  -m PATTERN      provider/model events containing PATTERN (case-insensitive)
  --top N         rows in model/project/session tables (default 20)
  --days N        rows in the daily table (default 14)
  --rebuild       drop the cache and re-index every session file
  --db PATH       override the cache database path
`;

interface GapOptions {
  showHelp: boolean;
  limit: number | null;
  since: string | undefined;
  until: string | undefined;
  project: string | undefined;
  model: string | undefined;
  binEdgesMin: number[];
  top: number;
  csv: string | undefined;
}

interface StatsOptions {
  showHelp: boolean;
  since: string | undefined;
  until: string | undefined;
  project: string | undefined;
  model: string | undefined;
  top: number;
  days: number;
  rebuild: boolean;
  db: string | undefined;
}

interface RunEnv {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function run(argv: readonly string[], env: RunEnv = {}): number {
  const stdout = env.stdout ?? console.log;
  const stderr = env.stderr ?? console.error;
  const isStatsMode = argv[0] === "stats";
  const rest = isStatsMode ? argv.slice(1) : argv;
  try {
    if (isStatsMode) return runStats(rest, stdout, stderr);
    return runGapAnalysis(rest, stdout, stderr);
  } catch (error) {
    stderr(`pi-stats: ${errorMessage(error)}`);
    return error instanceof ArgError ? 2 : 1;
  }
}

class ArgError extends Error {}

function runStats(
  argv: readonly string[],
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  let options: StatsOptions;
  try {
    options = parseStatsOptions(argv);
  } catch (error) {
    stderr(`pi-stats: ${errorMessage(error)}`);
    stderr(USAGE);
    return 2;
  }
  if (options.showHelp) {
    stdout(USAGE);
    return 0;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dbPath = options.db ?? defaultDbPath();
  if (options.rebuild && existsSync(dbPath)) rmSync(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new StatsDb(dbPath);
  try {
    const report = syncStatsDb(db);
    stderr(
      `pi-stats: indexed ${report.indexed} new/changed, removed ${report.removed}, total ${report.total} files`,
    );
    if (report.total === 0) {
      stderr("pi-stats: no session files found");
      return 1;
    }
    const projectByPath = new Map<string, string>();
    db.eachSession((record) => {
      projectByPath.set(record.path, record.project);
    });
    const source = buildFilteredSource(db, options, projectByPath);
    const summaryOptions = buildSummaryOptions(options, timeZone, projectByPath);
    const data = buildSummary(source, summaryOptions);
    stdout(renderSummary(data));
    return 0;
  } finally {
    db.close();
  }
}

interface SyncReport {
  indexed: number;
  removed: number;
  total: number;
}

export function syncStatsDb(db: StatsDb, root: string = SESSIONS_ROOT): SyncReport {
  const files = listSessionFiles(root);
  const tracked = db.getTracked();
  const livePaths = new Set<string>();
  let indexed = 0;
  let indexedEvents = 0;
  for (const file of files) {
    livePaths.add(file.path);
    const cached = tracked.get(file.path);
    if (cached !== undefined && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
      continue;
    }
    const session = indexSessionFile(file);
    if (session === null) continue;
    db.replaceSession(session.record, session.events);
    indexed += 1;
    indexedEvents += session.events.length;
  }
  const removed = [...tracked.keys()].filter((path) => !livePaths.has(path));
  db.removeSessions(removed);
  return { indexed, removed: removed.length, total: files.length };
}

function buildFilteredSource(
  db: StatsDb,
  options: StatsOptions,
  projectByPath: ReadonlyMap<string, string>,
): SummarySource {
  function matchesProject(sessionPath: string): boolean {
    return (
      options.project === undefined ||
      (projectByPath.get(sessionPath) ?? projectOfSession(sessionPath)).includes(options.project)
    );
  }
  function matchesModel(event: UsageEventRecord): boolean {
    return (
      options.model === undefined ||
      `${event.provider}/${event.model}`.toLowerCase().includes(options.model.toLowerCase())
    );
  }
  return {
    eachEvent(callback) {
      db.eachEvent((event) => {
        if (!matchesProject(event.sessionPath)) return;
        if (!matchesModel(event)) return;
        callback(event);
      });
    },
    eachSession(callback) {
      db.eachSession((record) => {
        if (!matchesProject(record.path)) return;
        callback(record);
      });
    },
  };
}

function buildSummaryOptions(
  options: StatsOptions,
  timeZone: string,
  projectByPath: ReadonlyMap<string, string>,
): SummaryOptions {
  const nowMs = Date.now();
  return {
    nowMs,
    timeZone,
    fromMs: parseLocalDateMs(options.since),
    untilMs: parseLocalDateMs(options.until),
    days: options.days,
    topModels: options.top,
    topProjects: options.top,
    topSessions: options.top,
    projectBySession: projectByPath,
  };
}

export function parseLocalDateMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ArgError(`invalid date (expected YYYY-MM-DD): ${raw}`);
  }
  const epochMs = Date.parse(`${raw}T00:00:00`);
  if (Number.isNaN(epochMs)) throw new ArgError(`invalid date: ${raw}`);
  return startOfLocalDay(epochMs, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function parseStatsOptions(argv: readonly string[]): StatsOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      since: { type: "string" },
      until: { type: "string" },
      project: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      top: { type: "string" },
      days: { type: "string" },
      rebuild: { type: "boolean" },
      db: { type: "string" },
    },
  });
  const top = parsePositiveInt(values.top, "--top") ?? DEFAULT_TOP;
  const days = parsePositiveInt(values.days, "--days") ?? DEFAULT_DAYS;
  return {
    showHelp: values.help === true,
    since: values.since,
    until: values.until,
    project: values.project,
    model: values.model,
    top,
    days,
    rebuild: values.rebuild === true,
    db: values.db,
  };
}

function runGapAnalysis(
  argv: readonly string[],
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  let options: GapOptions;
  try {
    options = parseGapOptions(argv);
  } catch (error) {
    stderr(`pi-stats: ${errorMessage(error)}`);
    stderr(USAGE);
    return 2;
  }
  if (options.showHelp) {
    stdout(USAGE);
    return 0;
  }
  const files = listSessionFilesLegacy(options);
  if (files.paths.length === 0) throw new Error("no session files matched the given filters");
  const { pairs, compactionSkips } = collectPairsFromFiles(files.paths, options.model);
  if (pairs.length === 0)
    throw new Error("no consecutive same-model response pairs found in the matched sessions");
  if (options.csv !== undefined) writeFileSync(options.csv, pairsToCsv(pairs));
  stdout(renderReport(files, pairs, compactionSkips, options));
  return 0;
}

function parseGapOptions(argv: readonly string[]): GapOptions {
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
    top: parsePositiveInt(values.top, "--top") ?? 12,
    csv: values.csv,
  };
}

function parsePositiveInt(raw: string | undefined, optionName: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgError(`${optionName} must be a positive integer: ${raw}`);
  }
  return value;
}

function parseDateMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const dateMs = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(dateMs)) throw new ArgError(`invalid date (expected YYYY-MM-DD): ${raw}`);
  return dateMs;
}

function listSessionFilesLegacy(options: GapOptions): { paths: string[]; mtimesMs: number[] } {
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
    const entries = loadEntries(path);
    if (entries === null) continue;
    const sessionName = basename(dirname(path));
    const result = collectSessionPairs(entries, sessionName, modelPattern);
    for (const pair of result.pairs) pairs.push(pair);
    compactionSkips += result.compactionSkips;
  }
  return { pairs, compactionSkips };
}

function loadEntries(path: string): SessionEntry[] | null {
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
  options: GapOptions,
): string {
  const oldestDate = new Date(Math.min(...files.mtimesMs)).toISOString().slice(0, 10);
  const newestDate = new Date(Math.max(...files.mtimesMs)).toISOString().slice(0, 10);
  const lines = [
    `sessions analyzed: ${files.paths.length}, period (file mtime): ${oldestDate} .. ${newestDate}`,
    `pair samples: ${pairs.length} consecutive same provider+model responses (skipped by compaction: ${compactionSkips})`,
    "hit rate = cacheRead / (input + cacheRead), averaged per gap-to-previous-response bucket",
    "",
    "per provider (all models merged):",
    renderTable(
      aggregate(pairs, options.binEdgesMin, (pair) => pair.provider),
      options.binEdgesMin,
    ),
    "",
    renderModelTable(pairs, options),
  ];
  if (options.csv !== undefined) lines.push("", `per-pair data written: ${options.csv}`);
  return lines.join("\n");
}

function renderModelTable(pairs: readonly Pair[], options: GapOptions): string {
  const modelTable = aggregate(
    pairs,
    options.binEdgesMin,
    (pair) => `${pair.provider}/${pair.model}`,
  );
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
