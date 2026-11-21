import type { SessionRecord, UsageEventRecord } from "./db";

const DAY_MS = 86_400_000;
const NAME_WIDTH_LIMIT = 42;

export type Totals = {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export interface OverviewRow {
  label: string;
  sessions: number;
  totals: Totals;
  hitRate: number | null;
}

export interface KeyedTotalsRow {
  key: string;
  sessions: number;
  totals: Totals;
  hitRate: number | null;
}

export interface DailyRow {
  dateKey: string;
  sessions: number;
  totals: Totals;
  hitRate: number | null;
}

export interface SessionListRow {
  startedLabel: string;
  project: string;
  topModel: string;
  requests: number;
  totalTokens: number;
  cost: number;
}

export interface SummaryOptions {
  nowMs: number;
  timeZone: string;
  fromMs: number | null;
  untilMs: number | null;
  days: number;
  topModels: number;
  topProjects: number;
  topSessions: number;
  projectBySession: ReadonlyMap<string, string>;
}

export interface SummaryData {
  overview: OverviewRow[];
  models: KeyedTotalsRow[];
  daily: DailyRow[];
  projects: KeyedTotalsRow[];
  sessions: SessionListRow[];
  eventCount: number;
  oldestEventMs: number | null;
  newestEventMs: number | null;
}

export interface SummarySource {
  eachEvent: (callback: (event: UsageEventRecord) => void) => void;
  eachSession: (callback: (record: SessionRecord) => void) => void;
}

interface TotalsAccumulator extends Totals {
  sessionIds: Set<string>;
}

function createAccumulator(): TotalsAccumulator {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    sessionIds: new Set<string>(),
  };
}

function addEvent(acc: TotalsAccumulator, event: UsageEventRecord): void {
  acc.requests += 1;
  acc.input += event.input;
  acc.output += event.output;
  acc.cacheRead += event.cacheRead;
  acc.cacheWrite += event.cacheWrite;
  acc.totalTokens += event.totalTokens;
  acc.cost += event.cost;
  acc.sessionIds.add(event.sessionPath);
}

function freezeTotals(acc: TotalsAccumulator): Totals {
  return {
    requests: acc.requests,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    totalTokens: acc.totalTokens,
    cost: acc.cost,
  };
}

export function hitRateOf(totals: Totals): number | null {
  const denominator = totals.input + totals.cacheRead;
  if (denominator === 0) return null;
  return totals.cacheRead / denominator;
}

function isMomentInRange(momentMs: number, options: SummaryOptions): boolean {
  if (options.fromMs !== null && momentMs < options.fromMs) return false;
  if (options.untilMs !== null && momentMs >= options.untilMs) return false;
  return true;
}

export function buildSummary(source: SummarySource, options: SummaryOptions): SummaryData {
  const periods = [
    { label: "today", fromMs: startOfLocalDay(options.nowMs, options.timeZone) },
    { label: "7 days", fromMs: options.nowMs - 7 * DAY_MS },
    { label: "30 days", fromMs: options.nowMs - 30 * DAY_MS },
    { label: "all", fromMs: null },
  ];
  const periodAccs = periods.map(() => createAccumulator());
  const modelAccs = new Map<string, TotalsAccumulator>();
  const dailyAccs = new Map<string, TotalsAccumulator>();
  const projectAccs = new Map<string, TotalsAccumulator>();
  const sessionAccs = new Map<
    string,
    TotalsAccumulator & { modelTokens: Map<string, number> }
  >();
  const todayStartMs = startOfLocalDay(options.nowMs, options.timeZone);
  const dailyCutoffMs = startOfLocalDay(
    todayStartMs - (options.days - 1) * DAY_MS,
    options.timeZone,
  );
  let eventCount = 0;
  let oldestEventMs: number | null = null;
  let newestEventMs: number | null = null;

  source.eachEvent((event) => {
    if (!isMomentInRange(event.tsMs, options)) return;
    eventCount += 1;
    if (oldestEventMs === null || event.tsMs < oldestEventMs) oldestEventMs = event.tsMs;
    if (newestEventMs === null || event.tsMs > newestEventMs) newestEventMs = event.tsMs;
    for (let index = 0; index < periods.length; index += 1) {
      const fromMs = periods[index]?.fromMs ?? null;
      if (fromMs !== null && event.tsMs < fromMs) continue;
      addEvent(periodAccs[index]!, event);
    }
    const modelKey = `${event.provider}/${event.model}`;
    const modelLabel = event.provider === "" && event.model === "" ? "(unknown)" : modelKey;
    addEvent(getOrCreate(modelAccs, modelLabel, createAccumulator), event);
    if (event.tsMs >= dailyCutoffMs) {
      const dateKey = localDateKey(event.tsMs, options.timeZone);
      addEvent(getOrCreate(dailyAccs, dateKey, createAccumulator), event);
    }
    addEvent(getOrCreate(projectAccs, projectLabelOf(event.sessionPath, options), createAccumulator), event);
    const sessionAcc = getOrCreate(sessionAccs, event.sessionPath, () => ({
      ...createAccumulator(),
      modelTokens: new Map<string, number>(),
    }));
    addEvent(sessionAcc, event);
    sessionAcc.modelTokens.set(
      modelLabel,
      (sessionAcc.modelTokens.get(modelLabel) ?? 0) + event.totalTokens,
    );
  });

  const startedSessionsByDay = new Map<string, number>();
  const startedSessionsPerPeriod = periods.map(() => 0);
  const sessionStarts = new Map<string, number | null>();
  source.eachSession((record) => {
    sessionStarts.set(record.path, record.startedMs);
    if (record.startedMs === null) return;
    if (!isMomentInRange(record.startedMs, options)) return;
    if (record.startedMs >= dailyCutoffMs) {
      const dateKey = localDateKey(record.startedMs, options.timeZone);
      startedSessionsByDay.set(dateKey, (startedSessionsByDay.get(dateKey) ?? 0) + 1);
    }
    for (let index = 0; index < periods.length; index += 1) {
      const fromMs = periods[index]?.fromMs ?? null;
      if (fromMs !== null && record.startedMs < fromMs) continue;
      startedSessionsPerPeriod[index] = (startedSessionsPerPeriod[index] ?? 0) + 1;
    }
  });

  const overview: OverviewRow[] = periods.map((period, index) => {
    const acc = periodAccs[index]!;
    return {
      label: period.label,
      sessions: startedSessionsPerPeriod[index] ?? 0,
      totals: freezeTotals(acc),
      hitRate: hitRateOf(acc),
    };
  });

  const models: KeyedTotalsRow[] = [...modelAccs.entries()]
    .map(([key, acc]) => ({
      key,
      sessions: acc.sessionIds.size,
      totals: freezeTotals(acc),
      hitRate: hitRateOf(acc),
    }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || compareStrings(a.key, b.key))
    .slice(0, options.topModels);

  const daily = buildDailyRows(dailyAccs, startedSessionsByDay, options);
  const projects = [...projectAccs.entries()]
    .map(([key, acc]) => ({
      key,
      sessions: acc.sessionIds.size,
      totals: freezeTotals(acc),
      hitRate: hitRateOf(acc),
    }))
    .sort((a, b) => b.totals.cost - a.totals.cost || compareStrings(a.key, b.key))
    .slice(0, options.topProjects);
  const sessions = [...sessionAccs.entries()]
    .map(([sessionPath, acc]) => buildSessionRow(sessionPath, acc, sessionStarts, options))
    .sort((a, b) => b.totalTokens - a.totalTokens || compareStrings(a.project, b.project))
    .slice(0, options.topSessions);

  return {
    overview,
    models,
    daily,
    projects,
    sessions,
    eventCount,
    oldestEventMs,
    newestEventMs,
  };
}

function buildDailyRows(
  dailyAccs: ReadonlyMap<string, TotalsAccumulator>,
  startedSessionsByDay: ReadonlyMap<string, number>,
  options: SummaryOptions,
): DailyRow[] {
  const todayStartMs = startOfLocalDay(options.nowMs, options.timeZone);
  const rows: DailyRow[] = [];
  for (let offset = options.days - 1; offset >= 0; offset -= 1) {
    const dayStartMs = todayStartMs - offset * DAY_MS;
    const dateKey = localDateKey(dayStartMs, options.timeZone);
    const acc = dailyAccs.get(dateKey);
    rows.push({
      dateKey,
      sessions: startedSessionsByDay.get(dateKey) ?? 0,
      totals: acc === undefined ? zeroTotals() : freezeTotals(acc),
      hitRate: acc === undefined ? null : hitRateOf(acc),
    });
  }
  return rows;
}



function buildSessionRow(
  sessionPath: string,
  acc: TotalsAccumulator & { modelTokens: Map<string, number> },
  sessionStarts: ReadonlyMap<string, number | null>,
  options: SummaryOptions,
): SessionListRow {
  let topModel = "";
  let topTokens = -1;
  for (const [model, tokens] of acc.modelTokens) {
    if (tokens > topTokens) {
      topTokens = tokens;
      topModel = model;
    }
  }
  const startedMs = sessionStarts.get(sessionPath);
  const startedLabel =
    startedMs === undefined || startedMs === null
      ? "—"
      : localDateTimeLabel(startedMs, options.timeZone);
  return {
    startedLabel,
    project: projectDisplayName(projectLabelOf(sessionPath, options)),
    topModel,
    requests: acc.requests,
    totalTokens: acc.totalTokens,
    cost: acc.cost,
  };
}

export interface Column<T> {
  header: string;
  align: "left" | "right";
  cell: (row: T) => string;
}

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const widths = columns.map((column) => displayWidth(column.header));
  for (const row of rows) {
    columns.forEach((column, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(column.cell(row)));
    });
  }
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => alignCell(cell, widths[index] ?? 0, columns[index]?.align ?? "left"))
      .join("  ");
  const lines = [
    renderRow(columns.map((column) => column.header)),
    columns.map((_column, index) => "-".repeat(widths[index] ?? 1)).join("  "),
  ];
  for (const row of rows) lines.push(renderRow(columns.map((column) => column.cell(row))));
  return lines.join("\n");
}

export function renderSummary(data: SummaryData): string {
  const lines: string[] = [];
  lines.push(
    `events: ${data.eventCount}, span (event time): ${formatSpan(data.oldestEventMs, data.newestEventMs)}`,
  );
  lines.push("");
  lines.push("overview (sessions = started in period):");
  lines.push(
    renderTable(data.overview, [
      { header: "period", align: "left", cell: (row) => row.label },
      { header: "sessions", align: "right", cell: (row) => String(row.sessions) },
      { header: "requests", align: "right", cell: (row) => String(row.totals.requests) },
      { header: "input", align: "right", cell: (row) => formatTokens(row.totals.input) },
      { header: "output", align: "right", cell: (row) => formatTokens(row.totals.output) },
      { header: "cache read", align: "right", cell: (row) => formatTokens(row.totals.cacheRead) },
      { header: "cache write", align: "right", cell: (row) => formatTokens(row.totals.cacheWrite) },
      { header: "hit%", align: "right", cell: (row) => formatPercent(row.hitRate) },
      { header: "cost", align: "right", cell: (row) => formatCost(row.totals.cost) },
    ]),
  );
  lines.push("");
  lines.push("per provider/model (top by tokens):");
  lines.push(
    renderTable(data.models, [
      { header: "provider/model", align: "left", cell: (row) => truncateName(row.key) },
      { header: "sessions", align: "right", cell: (row) => String(row.sessions) },
      { header: "requests", align: "right", cell: (row) => String(row.totals.requests) },
      { header: "input", align: "right", cell: (row) => formatTokens(row.totals.input) },
      { header: "output", align: "right", cell: (row) => formatTokens(row.totals.output) },
      { header: "cache read", align: "right", cell: (row) => formatTokens(row.totals.cacheRead) },
      { header: "cache write", align: "right", cell: (row) => formatTokens(row.totals.cacheWrite) },
      { header: "hit%", align: "right", cell: (row) => formatPercent(row.hitRate) },
      { header: "cost", align: "right", cell: (row) => formatCost(row.totals.cost) },
    ]),
  );
  lines.push("");
  lines.push("daily (local time, newest last):");
  lines.push(
    renderTable(data.daily, [
      { header: "date", align: "left", cell: (row) => row.dateKey },
      { header: "sessions", align: "right", cell: (row) => String(row.sessions) },
      { header: "requests", align: "right", cell: (row) => String(row.totals.requests) },
      { header: "input", align: "right", cell: (row) => formatTokens(row.totals.input) },
      { header: "output", align: "right", cell: (row) => formatTokens(row.totals.output) },
      { header: "cache read", align: "right", cell: (row) => formatTokens(row.totals.cacheRead) },
      { header: "hit%", align: "right", cell: (row) => formatPercent(row.hitRate) },
      { header: "cost", align: "right", cell: (row) => formatCost(row.totals.cost) },
    ]),
  );
  lines.push("");
  lines.push("per project (top by cost, sessions = sessions with usage):");
  lines.push(
    renderTable(data.projects, [
      { header: "project", align: "left", cell: (row) => truncateName(projectDisplayName(row.key)) },
      { header: "sessions", align: "right", cell: (row) => String(row.sessions) },
      { header: "requests", align: "right", cell: (row) => String(row.totals.requests) },
      { header: "tokens", align: "right", cell: (row) => formatTokens(row.totals.totalTokens) },
      { header: "hit%", align: "right", cell: (row) => formatPercent(row.hitRate) },
      { header: "cost", align: "right", cell: (row) => formatCost(row.totals.cost) },
    ]),
  );
  lines.push("");
  lines.push("top sessions (by tokens):");
  lines.push(
    renderTable(data.sessions, [
      { header: "started", align: "left", cell: (row) => row.startedLabel },
      { header: "project", align: "left", cell: (row) => truncateName(row.project) },
      { header: "top model", align: "left", cell: (row) => truncateName(row.topModel) },
      { header: "requests", align: "right", cell: (row) => String(row.requests) },
      { header: "tokens", align: "right", cell: (row) => formatTokens(row.totalTokens) },
      { header: "cost", align: "right", cell: (row) => formatCost(row.cost) },
    ]),
  );
  return lines.join("\n");
}

function formatSpan(oldestMs: number | null, newestMs: number | null): string {
  if (oldestMs === null || newestMs === null) return "n/a";
  return `${localDateKey(oldestMs, "UTC")} .. ${localDateKey(newestMs, "UTC")} (UTC)`;
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function projectOfSession(sessionPath: string): string {
  const withoutExtension = sessionPath.replace(/\.jsonl$/, "");
  const segments = withoutExtension.split("/");
  return segments.length >= 2 ? (segments[segments.length - 2] ?? "") : "";
}

function projectLabelOf(sessionPath: string, options: SummaryOptions): string {
  return options.projectBySession.get(sessionPath) ?? projectOfSession(sessionPath);
}

export function projectDisplayName(project: string): string {
  return project.replace(/^--/, "").replace(/--$/, "");
}

export function truncateName(name: string): string {
  return name.length <= NAME_WIDTH_LIMIT ? name : `${name.slice(0, NAME_WIDTH_LIMIT - 1)}…`;
}

export function localDateKey(epochMs: number, timeZone: string): string {
  const parts = dateTimeParts(epochMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localDateTimeLabel(epochMs: number, timeZone: string): string {
  const parts = dateTimeParts(epochMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function startOfLocalDay(epochMs: number, timeZone: string): number {
  const offset = tzOffsetMs(epochMs, timeZone);
  const localMs = epochMs + offset;
  const dayStartLocal = localMs - (((localMs % DAY_MS) + DAY_MS) % DAY_MS);
  return dayStartLocal - offset;
}

function zeroTotals(): Totals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function alignCell(cell: string, width: number, align: "left" | "right"): string {
  return align === "right" ? cell.padStart(width) : cell.padEnd(width);
}

function displayWidth(text: string): number {
  return [...text].length;
}

interface DateTimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    dateTimeFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function dateTimeParts(epochMs: number, timeZone: string): DateTimeParts {
  const parts = getDateTimeFormatter(timeZone).formatToParts(new Date(epochMs));
  const byType = new Map<string, string>();
  for (const part of parts) byType.set(part.type, part.value);
  return {
    year: byType.get("year") ?? "0000",
    month: byType.get("month") ?? "00",
    day: byType.get("day") ?? "00",
    hour: byType.get("hour") ?? "00",
    minute: byType.get("minute") ?? "00",
  };
}

export function tzOffsetMs(epochMs: number, timeZone: string): number {
  const parts = dateTimeParts(epochMs, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  const alignedEpoch = Math.floor(epochMs / 60_000) * 60_000;
  return asUtc - alignedEpoch;
}
