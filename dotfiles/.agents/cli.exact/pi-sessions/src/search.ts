import { spawn } from "node:child_process";
import { createReadStream, type ReadStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import {
  entryTypeLabel,
  extractEntryText,
  parseEntryLine,
  SUBAGENT_LOG_TYPE,
  asSubagentLog,
  type SessionEntry,
} from "./entry";
import { entryRecords, type RoleFilter } from "./records";
import { excerpt } from "./render";
import type { SessionFile } from "./sessions";

export type SearchHit = {
  sessionId: string;
  project: string;
  path: string;
  line: number;
  entryType: string;
  timestamp: string;
  text: string;
  invocationId: string | null;
  eventIndex: number | null;
};

export class RgUnavailableError extends Error {
  constructor() {
    super("rg (ripgrep) not found in PATH. Install ripgrep to use search.");
  }
}

export type SearchOptions = {
  limit?: number;
  role?: RoleFilter;
  rgCommand?: string;
};

type RgLine = { file: SessionFile; line: number; raw: string };
const MATCHED_LINE_MAX_COLUMNS = 100000;
const UNPARSED_EXCERPT_MAX_CHARS = 200;
const RAW_HEAD_MAX_CHARS = 300;
const EVENT_PREVIEW_COLUMNS = 1;

export async function runSearch(
  files: SessionFile[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  if (files.length === 0) return [];
  const rgCommand = options.rgCommand ?? "rg";
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const child = spawn(
    rgCommand,
    [
      "--line-number",
      "--no-heading",
      "--with-filename",
      "--null",
      "--max-columns",
      String(MATCHED_LINE_MAX_COLUMNS),
      "--max-columns-preview",
      "--",
      query,
      ...filesByPath.keys(),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const completion = new Promise<number | null>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new RgUnavailableError() : error);
    });
    child.on("close", resolve);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  void completion.catch(() => {
    lines.close();
    child.stdout.destroy();
  });
  const originals = new OriginalLineReader();
  const hits: SearchHit[] = [];
  let isStoppedByLimit = false;
  try {
    for await (const outputLine of lines) {
      const matched = parseRgLine(outputLine, filesByPath);
      if (matched === null) continue;
      const lineHits = await matchedLineHits(matched, query, options, originals);
      for (const hit of lineHits) {
        hits.push(hit);
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) {
        isStoppedByLimit = true;
        child.kill();
        break;
      }
    }
    const exitCode = await completion;
    if (!isStoppedByLimit && (exitCode === null || exitCode > 1)) {
      throw new Error(`rg failed with exit code ${exitCode}: ${stderr.trim()}`);
    }
    return hits;
  } finally {
    lines.close();
    child.stdout.destroy();
    originals.close();
    if (child.exitCode === null) child.kill();
  }
}

async function matchedLineHits(
  matched: RgLine,
  query: string,
  options: SearchOptions,
  originals: OriginalLineReader,
): Promise<SearchHit[]> {
  let entry = parseEntryLine(matched.raw);
  const type = entryTypeFromRawLine(matched.raw);
  const needsOriginal =
    entry === null &&
    (options.role !== undefined || type === "custom" || type === `custom:${SUBAGENT_LOG_TYPE}`);
  if (needsOriginal) entry = parseEntryLine(await originals.read(matched.file.path, matched.line));
  const base = buildHit(matched.file, matched.line, matched.raw, entry);
  if (entry?.type === "custom" && entry.customType === SUBAGENT_LOG_TYPE) {
    const childHits = matchChildEvents(entry, base, query, options);
    if (childHits.length > 0 || options.role !== undefined) return childHits;
  }
  if (
    options.role !== undefined &&
    (entry?.type !== "message" || entry.message?.role !== options.role)
  )
    return [];
  return [base];
}

function matchChildEvents(
  entry: SessionEntry,
  base: SearchHit,
  query: string,
  options: SearchOptions,
): SearchHit[] {
  const log = asSubagentLog(entry.data);
  const candidates = entryRecords(entry, base.line).filter(
    (record) => options.role === undefined || record.role === options.role,
  );
  if (candidates.length === 0) return [];
  const eventLines = candidates.map((record) =>
    JSON.stringify(log.events![record.eventIndex! - 1]),
  );
  const result = Bun.spawnSync(
    [
      options.rgCommand ?? "rg",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-columns",
      String(EVENT_PREVIEW_COLUMNS),
      "--max-columns-preview",
      "--",
      query,
    ],
    { stdin: Buffer.from(eventLines.join("\n") + "\n"), stdout: "pipe", stderr: "pipe" },
  );
  if (result.signalCode != null || (result.exitCode !== 0 && result.exitCode !== 1)) {
    const signal = result.signalCode == null ? "" : ` (signal ${result.signalCode})`;
    throw new Error(`rg event search failed${signal}: ${result.stderr.toString().trim()}`);
  }
  const hits: SearchHit[] = [];
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^(\d+):/.exec(line);
    if (match === null) continue;
    const record = candidates[Number(match[1]) - 1];
    if (record === undefined) continue;
    const event = log.events![record.eventIndex! - 1]!;
    hits.push({
      ...base,
      text: record.text,
      timestamp: event.timestamp ?? "",
      invocationId: record.invocationId,
      eventIndex: record.eventIndex,
    });
  }
  return hits;
}

export function parseRgOutputLine(
  outputLine: string,
  filesByPath: Map<string, SessionFile>,
): SearchHit | null {
  const matched = parseRgLine(outputLine, filesByPath);
  return matched === null ? null : buildHit(matched.file, matched.line, matched.raw);
}

function parseRgLine(outputLine: string, filesByPath: Map<string, SessionFile>): RgLine | null {
  const pathSeparator = outputLine.indexOf("\0");
  if (pathSeparator === -1) return null;
  const file = filesByPath.get(outputLine.slice(0, pathSeparator));
  if (file === undefined) return null;
  const rest = outputLine.slice(pathSeparator + 1);
  const lineSeparator = rest.indexOf(":");
  if (lineSeparator === -1) return null;
  const line = Number(rest.slice(0, lineSeparator));
  if (!Number.isInteger(line) || line < 1) return null;
  return { file, line, raw: rest.slice(lineSeparator + 1) };
}

function buildHit(
  file: SessionFile,
  line: number,
  rawLine: string,
  entry = parseEntryLine(rawLine),
): SearchHit {
  return {
    sessionId: file.sessionId,
    project: file.project,
    path: file.path,
    line,
    entryType: entry === null ? entryTypeFromRawLine(rawLine) : entryTypeLabel(entry),
    timestamp: entry === null ? timestampFromRawLine(rawLine) : (entry.timestamp ?? ""),
    text: entry === null ? excerpt(rawLine, UNPARSED_EXCERPT_MAX_CHARS) : extractEntryText(entry),
    invocationId: null,
    eventIndex: null,
  };
}

function entryTypeFromRawLine(rawLine: string): string {
  const head = rawLine.slice(0, RAW_HEAD_MAX_CHARS);
  const typeMatch = /"type"\s*:\s*"([^"]+)"/.exec(head);
  if (typeMatch === null) return "unparsed";
  if (typeMatch[1] === "custom") {
    const customTypeMatch = /"customType"\s*:\s*"([^"]+)"/.exec(head);
    if (customTypeMatch !== null) return `custom:${customTypeMatch[1]}`;
  }
  return typeMatch[1]!;
}

function timestampFromRawLine(rawLine: string): string {
  const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(rawLine.slice(0, RAW_HEAD_MAX_CHARS));
  return match?.[1] ?? "";
}

class OriginalLineReader {
  private path = "";
  private lineNumber = 0;
  private stream?: ReadStream;
  private lines?: Interface;
  private iterator?: AsyncIterableIterator<string>;

  async read(path: string, lineNumber: number): Promise<string> {
    if (this.path !== path || lineNumber <= this.lineNumber) {
      this.close();
      this.path = path;
      this.lineNumber = 0;
      this.stream = createReadStream(path, { encoding: "utf8" });
      this.lines = createInterface({ input: this.stream, crlfDelay: Infinity });
      this.iterator = this.lines[Symbol.asyncIterator]();
    }
    while (this.lineNumber < lineNumber) {
      const next = await this.iterator!.next();
      if (next.done) throw new Error(`cannot read search hit at ${path}:${lineNumber}`);
      this.lineNumber++;
      if (this.lineNumber === lineNumber) return next.value;
    }
    throw new Error(`invalid search hit line: ${path}:${lineNumber}`);
  }

  close(): void {
    this.lines?.close();
    this.stream?.destroy();
  }
}
