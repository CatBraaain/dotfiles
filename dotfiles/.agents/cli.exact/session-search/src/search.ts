import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, type ReadStream } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { dirname } from "node:path";
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
const EVENT_SEARCH_ARGS = [
  "--line-number",
  "--no-heading",
  "--color",
  "never",
  "--max-columns",
  String(EVENT_PREVIEW_COLUMNS),
  "--max-columns-preview",
];

type MatchEvents = (eventLines: string[]) => Promise<number[]>;

export async function runSearch(
  files: SessionFile[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  if (files.length === 0) return [];
  const rgCommand = options.rgCommand ?? "rg";
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  // rg receives directories, not each file: Windows caps a command line at 32,767 characters (https://learn.microsoft.com/cpp/windows/command-line-parameters).
  const projectDirs = [...new Set(files.map((file) => dirname(file.path)))];
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
      "--max-depth",
      "1",
      "--no-ignore",
      "--",
      query,
      ...projectDirs,
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
  const hasCustomRgConfig = Boolean(process.env.RIPGREP_CONFIG_PATH);
  let eventSearch: StreamingEventSearch | undefined;
  async function matchEvents(eventLines: string[]): Promise<number[]> {
    if (hasCustomRgConfig) return matchConfiguredEvents(rgCommand, query, eventLines);
    eventSearch ??= new StreamingEventSearch(rgCommand, query);
    return eventSearch.match(eventLines);
  }

  const hits: SearchHit[] = [];
  let isStoppedByLimit = false;
  try {
    for await (const outputLine of lines) {
      const matched = parseRgLine(outputLine, filesByPath);
      if (matched === null) continue;
      const lineHits = await matchedLineHits(matched, options.role, originals, matchEvents);
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
    await eventSearch?.finish();
    return hits;
  } finally {
    lines.close();
    child.stdout.destroy();
    originals.close();
    if (child.exitCode === null) child.kill();
    await eventSearch?.close();
  }
}

async function matchedLineHits(
  matched: RgLine,
  role: RoleFilter | undefined,
  originals: OriginalLineReader,
  matchEvents: MatchEvents,
): Promise<SearchHit[]> {
  let entry = parseEntryLine(matched.raw);
  const type = entryTypeFromRawLine(matched.raw);
  const needsOriginal =
    entry === null &&
    (role !== undefined || type === "custom" || type === `custom:${SUBAGENT_LOG_TYPE}`);
  if (needsOriginal) entry = parseEntryLine(await originals.read(matched.file.path, matched.line));
  const base = buildHit(matched.file, matched.line, matched.raw, entry);
  if (entry?.type === "custom" && entry.customType === SUBAGENT_LOG_TYPE) {
    const childHits = await matchChildEvents(entry, base, role, matchEvents);
    if (childHits.length > 0 || role !== undefined) return childHits;
  }
  if (role !== undefined && (entry?.type !== "message" || entry.message?.role !== role)) return [];
  return [base];
}

async function matchChildEvents(
  entry: SessionEntry,
  base: SearchHit,
  role: RoleFilter | undefined,
  matchEvents: MatchEvents,
): Promise<SearchHit[]> {
  const log = asSubagentLog(entry.data);
  const candidates = entryRecords(entry, base.line).filter(
    (record) => role === undefined || record.role === role,
  );
  if (candidates.length === 0) return [];
  const eventLines = candidates.map((record) =>
    JSON.stringify(log.events![record.eventIndex! - 1]),
  );
  const matchedIndices = await matchEvents(eventLines);
  const hits: SearchHit[] = [];
  for (const index of matchedIndices) {
    const record = candidates[index];
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

function matchConfiguredEvents(rgCommand: string, query: string, eventLines: string[]): number[] {
  const result = Bun.spawnSync([rgCommand, ...EVENT_SEARCH_ARGS, "--", query], {
    stdin: Buffer.from(eventLines.join("\n") + "\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const error = eventSearchError(
    result.exitCode,
    result.signalCode ?? null,
    result.stderr.toString(),
  );
  if (error !== null) throw error;
  return result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^(\d+):/.exec(line);
      return match === null ? [] : [Number(match[1]) - 1];
    });
}

function eventSearchError(
  code: number | null,
  signal: string | null,
  stderr: string,
): Error | null {
  if (signal === null && (code === 0 || code === 1)) return null;
  const signalDetail = signal === null ? "" : ` (signal ${signal})`;
  return new Error(`rg event search failed${signalDetail}: ${stderr.trim()}`);
}

class StreamingEventSearch {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly replies: AsyncIterableIterator<string>;
  private readonly completion: Promise<Error | null>;
  private sentLineCount = 0;
  private stdinError?: Error;

  constructor(rgCommand: string, query: string) {
    this.child = spawn(rgCommand, [
      ...EVENT_SEARCH_ARGS,
      "--line-buffered",
      "--passthru",
      "--",
      query,
      "-",
    ]);
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.replies = this.lines[Symbol.asyncIterator]();
    this.child.stdin.on("error", (error) => {
      this.stdinError = error;
    });
    let stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    this.completion = new Promise((resolve) => {
      this.child.on("error", (error) =>
        resolve(new Error(`rg event search failed: ${error.message}`)),
      );
      this.child.on("close", (code, signal) => resolve(eventSearchError(code, signal, stderr)));
    });
  }

  async match(eventLines: string[]): Promise<number[]> {
    const matchedIndices: number[] = [];
    this.child.stdin.write(eventLines.join("\n") + "\n");
    for (let index = 0; index < eventLines.length; index++) {
      const reply = await this.replies.next();
      const lineNumber = ++this.sentLineCount;
      if (reply.done) {
        throw (
          (await this.completion) ??
          this.stdinError ??
          new Error("rg event search ended before all replies arrived")
        );
      }
      if (reply.value.startsWith(`${lineNumber}:`)) {
        matchedIndices.push(index);
      } else if (!reply.value.startsWith(`${lineNumber}-`)) {
        throw new Error(`rg event search returned an invalid reply for line ${lineNumber}`);
      }
    }
    return matchedIndices;
  }

  async finish(): Promise<void> {
    this.child.stdin.end();
    const error = (await this.completion) ?? this.stdinError;
    if (error !== undefined) throw error;
  }

  async close(): Promise<void> {
    this.lines.close();
    this.child.stdout.destroy();
    this.child.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await this.completion;
  }
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
