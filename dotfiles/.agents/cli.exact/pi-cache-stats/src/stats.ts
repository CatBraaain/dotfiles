export interface SessionEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

export interface AssistantCandidate {
  epochMs: number;
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface Pair {
  provider: string;
  model: string;
  session: string;
  timestampIso: string;
  gapMinutes: number;
  input: number;
  cacheRead: number;
  totalTokens: number;
  hitRate: number;
}

export interface SessionPairResult {
  pairs: Pair[];
  compactionSkips: number;
}

export interface BucketTable {
  hitRatesByKey: Map<string, number[][]>;
  pairCountByKey: Map<string, number>;
}

export const DEFAULT_BIN_EDGES_MIN = [1, 5, 15, 30, 60, 180];

const MS_PER_MINUTE = 60_000;
const NAME_WIDTH_LIMIT = 42;
const PAIRS_WIDTH = 6;
const CELL_WIDTH = 15;
const COUNT_WIDTH = 7;

export function collectSessionPairs(
  entries: readonly SessionEntry[],
  sessionName: string,
  modelPattern: string | undefined,
): SessionPairResult {
  const pairs: Pair[] = [];
  let compactionSkips = 0;
  let previous: AssistantCandidate | null = null;
  let compactionsSincePrevious = 0;
  for (const entry of activeChain(entries)) {
    if (entry.type === "compaction") {
      compactionsSincePrevious += 1;
      continue;
    }
    const candidate = parseAssistantEntry(entry);
    if (candidate === null || !matchesModelFilter(candidate, modelPattern)) continue;
    if (previous !== null) {
      const isSameModelAsPrevious =
        previous.provider === candidate.provider && previous.model === candidate.model;
      if (isSameModelAsPrevious) {
        const gapMinutes = (candidate.epochMs - previous.epochMs) / MS_PER_MINUTE;
        const denominator = candidate.inputTokens + candidate.cacheReadTokens;
        const isUsableSample = gapMinutes >= 0 && denominator > 0;
        const isSplitByCompaction = compactionsSincePrevious > 0;
        if (isUsableSample && isSplitByCompaction) {
          compactionSkips += 1;
        } else if (isUsableSample) {
          pairs.push(buildPair(candidate, previous, sessionName));
        }
      }
    }
    previous = candidate;
    compactionsSincePrevious = 0;
  }
  return { pairs, compactionSkips };
}

export function activeChain(entries: readonly SessionEntry[]): SessionEntry[] {
  const entriesById = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") entriesById.set(entry.id, entry);
  }
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = entries.at(-1);
  while (current !== undefined) {
    chain.push(current);
    const parentId = current.parentId;
    current = typeof parentId === "string" ? entriesById.get(parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

export function parseAssistantEntry(entry: SessionEntry): AssistantCandidate | null {
  const message: Record<string, unknown> = isRecord(entry.message) ? entry.message : {};
  if (message.role !== "assistant") return null;
  const epochMs = entryEpochMs(entry);
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";
  if (epochMs === null || provider === "" || model === "") return null;
  const usage: Record<string, unknown> = isRecord(message.usage) ? message.usage : {};
  return {
    epochMs,
    provider,
    model,
    inputTokens: numberOrZero(usage.input),
    cacheReadTokens: numberOrZero(usage.cacheRead),
    totalTokens: numberOrZero(usage.totalTokens),
  };
}

export function entryEpochMs(entry: SessionEntry): number | null {
  if (typeof entry.timestamp !== "string" || entry.timestamp === "") return null;
  const epochMs = Date.parse(entry.timestamp);
  return Number.isNaN(epochMs) ? null : epochMs;
}

export function matchesModelFilter(candidate: AssistantCandidate, modelPattern: string | undefined): boolean {
  if (modelPattern === undefined || modelPattern === "") return true;
  const modelKey = `${candidate.provider}/${candidate.model}`;
  return modelKey.toLowerCase().includes(modelPattern.toLowerCase());
}

export function buildPair(candidate: AssistantCandidate, previous: AssistantCandidate, sessionName: string): Pair {
  const gapMinutes = (candidate.epochMs - previous.epochMs) / MS_PER_MINUTE;
  const denominator = candidate.inputTokens + candidate.cacheReadTokens;
  return {
    provider: candidate.provider,
    model: candidate.model,
    session: sessionName,
    timestampIso: new Date(candidate.epochMs).toISOString(),
    gapMinutes: Math.round(gapMinutes * 10_000) / 10_000,
    input: candidate.inputTokens,
    cacheRead: candidate.cacheReadTokens,
    totalTokens: candidate.totalTokens,
    hitRate: candidate.cacheReadTokens / denominator,
  };
}

export function aggregate(
  pairs: readonly Pair[],
  binEdgesMin: readonly number[],
  keyOfPair: (pair: Pair) => string,
): BucketTable {
  const bucketCount = binEdgesMin.length + 1;
  const hitRatesByKey = new Map<string, number[][]>();
  const pairCountByKey = new Map<string, number>();
  for (const pair of pairs) {
    const key = keyOfPair(pair);
    let buckets = hitRatesByKey.get(key);
    if (buckets === undefined) {
      buckets = Array.from({ length: bucketCount }, () => []);
      hitRatesByKey.set(key, buckets);
      pairCountByKey.set(key, 0);
    }
    buckets[bisectRight(binEdgesMin, pair.gapMinutes)].push(pair.hitRate);
    pairCountByKey.set(key, (pairCountByKey.get(key) ?? 0) + 1);
  }
  return { hitRatesByKey, pairCountByKey };
}

export function renderTable(table: BucketTable, binEdgesMin: readonly number[]): string {
  const keyLengths = [...table.pairCountByKey.keys()].map((key) => key.length);
  const longestNameLen = Math.max(...keyLengths, "provider/model".length);
  const nameWidth = Math.min(NAME_WIDTH_LIMIT, longestNameLen);
  const labels = binLabels(binEdgesMin);
  const header =
    `${"provider/model".padEnd(nameWidth)}  ${"pairs".padStart(PAIRS_WIDTH)}  ` +
    labels.map((label) => label.padStart(CELL_WIDTH)).join("  ");
  const lines = [header, "-".repeat(header.length)];
  for (const key of keysByCountDesc(table.pairCountByKey)) {
    const shortName = key.slice(0, nameWidth).padEnd(nameWidth);
    const cells = (table.hitRatesByKey.get(key) ?? []).map(renderCell);
    const pairCount = String(table.pairCountByKey.get(key) ?? 0).padStart(PAIRS_WIDTH);
    lines.push(`${shortName}  ${pairCount}  ${cells.join("  ")}`);
  }
  return lines.join("\n");
}

export function binLabels(binEdgesMin: readonly number[]): string[] {
  const labels: string[] = [];
  let lowerEdge = 0;
  for (const edge of binEdgesMin) {
    labels.push(`${formatMinutes(lowerEdge)}-${formatMinutes(edge)}`);
    lowerEdge = edge;
  }
  labels.push(`>${formatMinutes(lowerEdge)}`);
  return labels;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${minutes / 60}h`;
}

export function keysByCountDesc(pairCountByKey: ReadonlyMap<string, number>): string[] {
  return [...pairCountByKey.keys()].sort((a, b) => (pairCountByKey.get(b) ?? 0) - (pairCountByKey.get(a) ?? 0));
}

export function parseBinEdgesMin(raw: string | undefined): number[] {
  if (raw === undefined) return [...DEFAULT_BIN_EDGES_MIN];
  const edges = raw.split(",").map((part) => Number(part));
  const hasNonPositiveEdge = edges.some((edge) => !(edge > 0));
  const isNonAscending = edges.some((edge, index) => index > 0 && edge <= edges[index - 1]);
  if (hasNonPositiveEdge || isNonAscending) throw new Error(`--bins must be positive and ascending: ${raw}`);
  return edges;
}

function renderCell(hitRates: readonly number[]): string {
  if (hitRates.length === 0) return " ".repeat(CELL_WIDTH);
  const meanPercent = (hitRates.reduce((sum, rate) => sum + rate, 0) / hitRates.length) * 100;
  const cell = `${meanPercent.toFixed(0).padStart(4)}% (${String(hitRates.length).padStart(COUNT_WIDTH)})`;
  return cell.padStart(CELL_WIDTH);
}

function bisectRight(sortedValues: readonly number[], value: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (value < sortedValues[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
