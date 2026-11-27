import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IndexedSession, SessionRecord, UsageEventRecord } from "./db";
import { activeChain, entryEpochMs, type SessionEntry } from "./stats";

export const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export interface ScannedFile {
  path: string;
  mtimeMs: number;
  size: number;
  project: string;
  isSubagent: boolean;
}

export function listSessionFiles(root: string = SESSIONS_ROOT): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const dirEntry of readdirSync(root, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) continue;
    walkProjectDir(join(root, dirEntry.name), dirEntry.name, false, files);
  }
  return files;
}

function walkProjectDir(
  dir: string,
  project: string,
  underSubagents: boolean,
  out: ScannedFile[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const isSubagentDir = underSubagents || entry.name === "subagents";
      walkProjectDir(path, project, isSubagentDir, out);
    } else if (entry.name.endsWith(".jsonl")) {
      const stats = statSync(path);
      out.push({
        path,
        mtimeMs: Math.round(stats.mtimeMs),
        size: stats.size,
        project,
        isSubagent: underSubagents,
      });
    }
  }
}

export function indexSessionFile(file: ScannedFile): IndexedSession | null {
  const entries = loadEntries(file.path);
  if (entries === null) return null;
  const header = entries.find((entry) => entry.type === "session");
  const sessionId = typeof header?.id === "string" ? header.id : null;
  const cwd = typeof header?.cwd === "string" ? header.cwd : null;
  const headerTs = header === undefined ? null : entryEpochMs(header);
  const startedMs =
    headerTs ??
    entries.map((entry) => entryEpochMs(entry)).find((value): value is number => value !== null) ??
    null;
  const record: SessionRecord = {
    path: file.path,
    mtimeMs: file.mtimeMs,
    size: file.size,
    project: file.project,
    sessionId,
    cwd,
    startedMs,
    isSubagent: file.isSubagent,
  };
  const events = collectUsageEvents(entries, file.path);
  return { record, events };
}

export function collectUsageEvents(
  entries: readonly SessionEntry[],
  sessionPath: string,
): UsageEventRecord[] {
  const events: UsageEventRecord[] = [];
  for (const entry of activeChain(entries)) {
    const tsMs = entryEpochMs(entry);
    if (tsMs === null) continue;
    if (entry.type === "usage" || entry.type === "compaction") {
      const record = isRecord(entry) ? entry : {};
      const usage = readUsage(record);
      if (usage !== null) {
        events.push(
          buildEvent({
            sessionPath,
            tsMs,
            kind: entry.type,
            provider: stringOrEmpty(record.provider),
            model: stringOrEmpty(record.model),
            usage,
          }),
        );
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : {};
    if (message.role !== "assistant") continue;
    const usage = readUsage(message);
    if (usage === null) continue;
    events.push(
      buildEvent({
        sessionPath,
        tsMs,
        kind: "message",
        provider: stringOrEmpty(message.provider),
        model: stringOrEmpty(message.model),
        usage,
      }),
    );
  }
  return events;
}

interface UsageNumbers {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

function readUsage(container: Record<string, unknown>): UsageNumbers | null {
  const usage = isRecord(container.usage) ? container.usage : null;
  if (usage === null) return null;
  return {
    input: numberOrZero(usage.input),
    output: numberOrZero(usage.output),
    cacheRead: numberOrZero(usage.cacheRead),
    cacheWrite: numberOrZero(usage.cacheWrite),
    totalTokens: numberOrZero(usage.totalTokens),
    cost: costTotal(usage.cost),
  };
}

function buildEvent(input: {
  sessionPath: string;
  tsMs: number;
  kind: string;
  provider: string;
  model: string;
  usage: UsageNumbers;
}): UsageEventRecord {
  return {
    sessionPath: input.sessionPath,
    tsMs: input.tsMs,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    input: input.usage.input,
    output: input.usage.output,
    cacheRead: input.usage.cacheRead,
    cacheWrite: input.usage.cacheWrite,
    totalTokens: input.usage.totalTokens,
    cost: input.usage.cost,
  };
}

function costTotal(value: unknown): number {
  if (!isRecord(value)) return 0;
  return numberOrZero(value.total);
}

export function loadEntries(path: string): SessionEntry[] | null {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    return lines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEntry);
  } catch {
    return null;
  }
}

export function sessionDisplayName(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
