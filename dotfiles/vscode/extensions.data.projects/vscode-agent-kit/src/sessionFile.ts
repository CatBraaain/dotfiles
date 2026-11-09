import { open } from "node:fs/promises";
import { isRecord } from "./guards";

/**
 * Read-only parsing of Pi session JSONL files (no VS Code API).
 * Session files are never modified by this extension.
 *
 * Scanning is buffer-based for performance: real-world session directories
 * hold hundreds of files totaling gigabytes, with average line lengths in the
 * tens of kilobytes (and occasional multi-megabyte lines). Line-by-line
 * decoding (readline) is prohibitively slow, so files are scanned in large
 * binary chunks with byte-needle searches:
 *
 * - Header: first non-empty line within the first 1 MiB of the file.
 * - First user message: forward scan for lines containing `"role":"user"`
 *   (every serialized user message contains it; candidate lines are parsed
 *   and validated, so false positives inside string values are skipped).
 * - Latest session_info name: backward scan for lines containing
 *   `"type":"session_info"` (the first hit from the end is the latest;
 *   candidate lines are parsed and validated).
 *
 * Candidate lines are extracted with targeted reads around the match, never by
 * accumulating whole chunks, so multi-megabyte lines cannot cause quadratic
 * copying. Semantics match a full sequential parse (see test/sessionFile.test.ts).
 */

/** Header fields this extension needs from a session file's first line. */
export interface SessionHeaderInfo {
  id: string;
  cwd: string;
  timestamp?: string;
}

export interface SessionSummaryInfo {
  header: SessionHeaderInfo;
  displayName: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/** Max length of the first-user-message fallback display name (in code points). */
export const MAX_NAME_LENGTH = 80;

const HEADER_SCAN_BYTES = 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const LINE_STEP_BYTES = 64 * 1024;
const SESSION_INFO_NEEDLE = Buffer.from('"type":"session_info"', "utf8");
const ROLE_USER_NEEDLE = Buffer.from('"role":"user"', "utf8");
const ACTIVITY_NEEDLES = [Buffer.from('"message"', "utf8"), Buffer.from('"compaction"', "utf8")];

/** Parse the first line of a session file; null when it is not a valid session header. */
export function parseSessionHeader(line: string): SessionHeaderInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "session") return null;
  if (typeof parsed.id !== "string" || parsed.id === "") return null;
  if (typeof parsed.cwd !== "string" || parsed.cwd === "") return null;
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
  return { id: parsed.id, cwd: parsed.cwd, timestamp };
}

/**
 * Accumulator for display-name detection.
 * `latestSessionInfoName` follows pi's getSessionName semantics: the latest
 * session_info entry decides, and an empty name clears the title (falls back).
 */
export interface SessionNameScan {
  latestSessionInfoName: string | undefined;
  firstUserText: string | undefined;
}

export function createNameScan(): SessionNameScan {
  return { latestSessionInfoName: undefined, firstUserText: undefined };
}

/** Fold one non-header JSONL line into the scan. Unparseable lines are skipped. */
export function foldSessionEntryLine(scan: SessionNameScan, line: string): void {
  const entry = tryParseRecord(line);
  if (entry === null) return;
  if (entry.type === "session_info") {
    scan.latestSessionInfoName = sessionInfoName(entry);
    return;
  }
  if (entry.type === "message" && scan.firstUserText === undefined) {
    const message = entry.message;
    if (isRecord(message) && message.role === "user") {
      const text = userMessageText(message.content);
      if (text !== undefined && text.trim() !== "") {
        scan.firstUserText = text;
      }
    }
  }
}

/** Display name: session_info name, else first line of the first user message (<=80 chars), else "Untitled". */
export function displayNameFromScan(scan: SessionNameScan): string {
  if (scan.latestSessionInfoName !== undefined) return scan.latestSessionInfoName;
  return firstLineSnippet(scan.firstUserText) ?? "Untitled";
}

/**
 * Summarize one session file: header (id/cwd/timestamp) and display name.
 * Returns null when the file is empty or its first non-empty line is not a
 * valid session header (the file is then not a Pi session).
 */
export async function summarizeSessionFile(filePath: string): Promise<SessionSummaryInfo | null> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const header = await readHeader(handle, size);
    if (header === null) return null;
    const scan = createNameScan();
    const [latestSessionInfo, firstUserText, latestActivity] = await Promise.all([
      scanLatestEntry(
        handle,
        size,
        [SESSION_INFO_NEEDLE],
        (entry) => entry.type === "session_info",
      ),
      scanFirstUserText(handle, size),
      scanLatestEntry(handle, size, ACTIVITY_NEEDLES, isTimestampedActivity, LINE_STEP_BYTES),
    ]);
    scan.latestSessionInfoName =
      latestSessionInfo === undefined ? undefined : sessionInfoName(latestSessionInfo);
    scan.firstUserText = firstUserText;
    return {
      header,
      displayName: displayNameFromScan(scan),
      createdAtMs: parseTimestampMs(header.timestamp),
      updatedAtMs:
        parseTimestampMs(latestActivity?.timestamp) ?? parseTimestampMs(header.timestamp),
    };
  } finally {
    await handle.close();
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readHeader(handle: FileHandle, size: number): Promise<SessionHeaderInfo | null> {
  const length = Math.min(size, HEADER_SCAN_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  let start = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      Math.min(LINE_STEP_BYTES, length - filled),
      filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
    const window = buffer.subarray(0, filled);
    let newline = window.indexOf(10, start);
    while (newline !== -1) {
      const line = window.subarray(start, newline).toString("utf8").trim();
      if (line !== "") return parseSessionHeader(line);
      start = newline + 1;
      newline = window.indexOf(10, start);
    }
  }
  const line = buffer.subarray(start, filled).toString("utf8").trim();
  return line === "" ? null : parseSessionHeader(line);
}

async function scanFirstUserText(handle: FileHandle, size: number): Promise<string | undefined> {
  const overlap = ROLE_USER_NEEDLE.length - 1;
  const buffer = Buffer.allocUnsafe(Math.min(size, CHUNK_BYTES) + overlap);
  let carryLength = 0;
  let chunkBytes = LINE_STEP_BYTES;
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      carryLength,
      Math.min(chunkBytes, size - position),
      position,
    );
    if (bytesRead === 0) break;
    const windowStart = position - carryLength;
    position += bytesRead;
    const window = buffer.subarray(0, carryLength + bytesRead);
    let match = window.indexOf(ROLE_USER_NEEDLE);
    while (match !== -1) {
      const line = await readLineContaining(handle, size, windowStart + match, {
        buffer: window,
        startAbs: windowStart,
      });
      const scan = createNameScan();
      foldSessionEntryLine(scan, line.text);
      if (scan.firstUserText !== undefined) return scan.firstUserText;
      match = window.indexOf(ROLE_USER_NEEDLE, line.endAbs + 1 - windowStart);
    }
    carryLength = Math.min(overlap, window.length);
    window.copy(buffer, 0, window.length - carryLength);
    chunkBytes = CHUNK_BYTES;
  }
  return undefined;
}

async function scanLatestEntry(
  handle: FileHandle,
  size: number,
  needles: readonly Buffer[],
  matches: (entry: Record<string, unknown>) => boolean,
  initialChunkBytes = CHUNK_BYTES,
): Promise<Record<string, unknown> | undefined> {
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  const buffer = Buffer.allocUnsafe(Math.min(size, CHUNK_BYTES) + overlap);
  let headLength = 0;
  let chunkBytes = initialChunkBytes;
  let readEnd = size;
  while (readEnd > 0) {
    const length = Math.min(chunkBytes, readEnd);
    const chunkStart = readEnd - length;
    buffer.copy(buffer, length, 0, headLength);
    const { bytesRead } = await handle.read(buffer, 0, length, chunkStart);
    readEnd = chunkStart;
    const continuationLength = bytesRead === length ? headLength : 0;
    const window = buffer.subarray(0, bytesRead + continuationLength);
    let searchBefore = bytesRead - 1;
    while (searchBefore >= 0) {
      const match = Math.max(...needles.map((needle) => window.lastIndexOf(needle, searchBefore)));
      if (match === -1) break;
      const line = await readLineContaining(handle, size, chunkStart + match, {
        buffer: window,
        startAbs: chunkStart,
      });
      const entry = tryParseRecord(line.text);
      if (entry !== null && matches(entry)) return entry;
      searchBefore = line.startAbs - 1 - chunkStart;
    }
    headLength = Math.min(overlap, bytesRead);
    chunkBytes = CHUNK_BYTES;
  }
  return undefined;
}

interface ExtractedLine {
  text: string;
  startAbs: number;
  endAbs: number; // position of the terminating newline, or `size` for the last line
}

interface ScanWindow {
  buffer: Buffer;
  startAbs: number;
}

async function readLineContaining(
  handle: FileHandle,
  size: number,
  position: number,
  window: ScanWindow,
): Promise<ExtractedLine> {
  const offset = position - window.startAbs;
  const previousNewline = offset === 0 ? -1 : window.buffer.lastIndexOf(10, offset - 1);
  const nextNewline = window.buffer.indexOf(10, offset);
  const startsInWindow = previousNewline !== -1 || window.startAbs === 0;
  const endsInWindow = nextNewline !== -1 || window.startAbs + window.buffer.length === size;
  if (startsInWindow && endsInWindow) {
    const start = previousNewline + 1;
    const end = nextNewline === -1 ? window.buffer.length : nextNewline;
    return {
      text: window.buffer.subarray(start, end).toString("utf8"),
      startAbs: window.startAbs + start,
      endAbs: window.startAbs + end,
    };
  }

  let startAbs = 0;
  let scanEnd = position;
  while (scanEnd > 0) {
    const from = Math.max(0, scanEnd - LINE_STEP_BYTES);
    const buffer = await readAt(handle, from, scanEnd);
    const newline = buffer.lastIndexOf(10);
    if (newline !== -1) {
      startAbs = from + newline + 1;
      break;
    }
    if (from === 0) break;
    scanEnd = from;
  }
  let endAbs = size;
  let scanFrom = position;
  while (scanFrom < size) {
    const to = Math.min(size, scanFrom + LINE_STEP_BYTES);
    const buffer = await readAt(handle, scanFrom, to);
    const newline = buffer.indexOf(10);
    if (newline !== -1) {
      endAbs = scanFrom + newline;
      break;
    }
    if (to === size) break;
    scanFrom = to;
  }
  const line = await readAt(handle, startAbs, endAbs);
  return { text: line.toString("utf8"), startAbs, endAbs };
}

async function readAt(handle: FileHandle, position: number, end: number): Promise<Buffer> {
  const length = end - position;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function tryParseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTimestampedActivity(entry: Record<string, unknown>): boolean {
  return (
    (entry.type === "message" || entry.type === "compaction") &&
    parseTimestampMs(entry.timestamp) !== null
  );
}

function parseTimestampMs(timestamp: unknown): number | null {
  if (typeof timestamp !== "string") return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function sessionInfoName(entry: Record<string, unknown>): string | undefined {
  return typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : undefined;
}

/** Extract text from a user message content (string, or array of content blocks). */
function userMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) return undefined;
    return texts.join(" ");
  }
  return undefined;
}

function firstLineSnippet(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const firstLine = (trimmed.split(/\r?\n/)[0] ?? "").trim();
  const snippet = [...firstLine].slice(0, MAX_NAME_LENGTH).join("");
  return snippet === "" ? undefined : snippet;
}
