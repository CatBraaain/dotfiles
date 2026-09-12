// Pure IO logic shared by the sandbox runner (src/runner.ts, executes inside
// bwrap) and the host-side tool definitions (src/tools.ts): read windows and
// footers, write/edit envelopes and literal replacement, ls output with the
// entry/byte caps, glob/grep retention and formatting, bash stream capping,
// and image signature sniffing (SPEC §1, §2.1, §4 caps). No fs or process
// access lives here, so everything is unit-testable without a sandbox.

import { extname } from "node:path";

// ---------------------------------------------------------------------------
// read (SPEC §1: 2000-line default/cap, 2000 chars per line, continuation footer)
// ---------------------------------------------------------------------------

export const READ_LIMIT_DEFAULT = 2000;
export const READ_MAX_LINE_LENGTH = 2000;

export function truncateReadLine(line: string, maxLineLength = READ_MAX_LINE_LENGTH): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line;
}

export type ReadWindowLine = { number: number; text: string };

export type ReadWindow = { lines: ReadWindowLine[]; totalLines: number };

/**
 * Build one numbered window from whole-file text (the runner already read the
 * file). Counts every line so the footer reports the true total, trims `\r`,
 * and truncates each kept line to `maxLineLength` characters, following the
 * stock dsh-tool-fs behavior (SPEC §1).
 */
export function buildReadWindow(
  content: string,
  offset: number,
  limit: number,
  maxLineLength = READ_MAX_LINE_LENGTH,
): ReadWindow {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const window: ReadWindowLine[] = [];
  let totalLines = 0;
  for (const rawLine of lines) {
    totalLines += 1;
    if (totalLines < offset || window.length >= limit) continue;
    const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    window.push({ number: totalLines, text: truncateReadLine(trimmed, maxLineLength) });
  }
  if (offset > totalLines && !(totalLines === 0 && offset === 1))
    throw new Error(`offset ${offset} is out of range (${totalLines} lines)`);
  return { lines: window, totalLines };
}

/** The continuation or end-of-file footer line (stock dsh-tool-fs wording). */
export function readFooter(window: ReadWindow, offset: number): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, offset - 1);
  return endLine < window.totalLines
    ? `(Showing lines ${offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
    : `(End of file - total ${window.totalLines} lines)`;
}

export function formatReadOutput(displayPath: string, window: ReadWindow, offset: number): string {
  const body =
    window.lines.length > 0
      ? `${window.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${readFooter(window, offset)}`
      : readFooter(window, offset);
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

// ---------------------------------------------------------------------------
// write / edit (SPEC §1 envelopes, §2.4 stale wording lives in tools.ts)
// ---------------------------------------------------------------------------

export function formatWriteOutput(displayPath: string, operation: "create" | "update"): string {
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${operation === "create" ? "Created" : "Updated"} file\n</content>`;
}

export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`;
}

/**
 * Apply a literal replacement to file content. Error wording follows the
 * stock dsh-fs-local `applyLiteralEdit` (SPEC §1: unique match unless
 * `replace_all`). Both content and the search/replace texts are LF-normalized
 * before matching, matching the stock behavior on CRLF files.
 */
export function applyEditLiteral(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const normalize = (text: string): string => text.replaceAll("\r\n", "\n");
  const oldNorm = normalize(oldString);
  if (oldNorm.length === 0) throw new Error("old_string must be a non-empty string");
  const newNorm = normalize(newString);
  const contentNorm = normalize(content);
  let replacements = 0;
  let searchFrom = 0;
  while (searchFrom <= contentNorm.length) {
    const at = contentNorm.indexOf(oldNorm, searchFrom);
    if (at === -1) break;
    replacements += 1;
    searchFrom = at + oldNorm.length;
  }
  if (replacements === 0) throw new Error(`old_string was not found in "${displayPath}"`);
  if (!replaceAll && replacements > 1)
    throw new Error(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
    );
  return { content: contentNorm.split(oldNorm).join(newNorm), replacements };
}

// ---------------------------------------------------------------------------
// read_image format sniffing (SPEC §2.1: signature first, extension assist)
// ---------------------------------------------------------------------------

/** Extensions read_image accepts, mapped to their declared media type. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function matchesBytes(data: Buffer, offset: number, expected: number[]): boolean {
  if (data.byteLength < offset + expected.length) return false;
  return expected.every((byte, index) => data[offset + index] === byte);
}

function matchesAscii(data: Buffer, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1)
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  return true;
}

/** Identify the media type declared by a supported image file signature. */
export function sniffImageMediaType(data: Buffer): string | undefined {
  if (matchesBytes(data, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (matchesBytes(data, 0, [255, 216, 255])) return "image/jpeg";
  if (matchesAscii(data, 0, "GIF87a") || matchesAscii(data, 0, "GIF89a")) return "image/gif";
  if (matchesAscii(data, 0, "RIFF") && matchesAscii(data, 8, "WEBP")) return "image/webp";
  return undefined;
}

/** The declared media type for a path extension, or undefined when unsupported. */
export function imageMediaTypeForPath(filePath: string): string | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
}

// ---------------------------------------------------------------------------
// glob (SPEC §1: modification-time order, 100-path cap)
// ---------------------------------------------------------------------------

export const GLOB_MAX_RESULTS = 100;

/** VCS metadata directories excluded from discovery (stock dsh-tool-fs-search). */
export const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/** Ripgrep argv for one `glob` call (argv elements only; the runner spawns `rgPath --no-config ...argv`).
 * `--sortr=modified` orders newest-first per SPEC §1 (rg's `--sort=modified`
 * is ascending; the stock tool uses it and stays direction-agnostic). */
export function buildGlobArgv(pattern: string): string[] {
  return [
    "--files",
    `--glob=${pattern}`,
    "--sortr=modified",
    "--no-ignore",
    "--hidden",
    ...GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
  ];
}

export function renderGlobPaths(paths: readonly string[], maxResults = GLOB_MAX_RESULTS): string {
  if (paths.length === 0) return "No files found";
  if (paths.length <= maxResults) return paths.join("\n");
  const body = paths.slice(0, maxResults).join("\n");
  return `${body}\n\n(Showing ${maxResults} of ${paths.length} paths. The complete result could not be saved; narrow pattern or path to see more.)`;
}

// ---------------------------------------------------------------------------
// grep (SPEC §1: Line N previews, single positive include, 250-match cap)
// ---------------------------------------------------------------------------

export const GREP_MAX_MATCHES = 250;
export const GREP_MAX_LINE_BYTES = 2000;

/**
 * Reject an `include` that is not one positive glob filter: blank strings,
 * negated patterns, and comma-separated lists (a comma inside a brace group is
 * alternation, not a list) — stock dsh-tool-fs-search wording (SPEC §1).
 */
export function validateGrepInclude(include: string): void {
  if (include.trim().length === 0) throw new Error("include must be a non-empty glob when given");
  if (include.startsWith("!"))
    throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported');
  let braceDepth = 0;
  for (const char of include) {
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "," && braceDepth === 0)
      throw new Error("include must be one glob, not a comma-separated list (use {a,b} alternation instead)");
  }
}

/** One parsed `rg --json` match record. */
export type GrepMatch = { path: string; lineNumber: number; line: string };

/** Ripgrep argv for one `grep` call (the runner spawns `rgPath --no-config ...argv`). */
export function buildGrepArgv(pattern: string, include?: string): string[] {
  const parts = ["--json", `--regexp=${pattern}`];
  if (include !== undefined) parts.push(`--glob=${include}`);
  return parts;
}

/** Parse complete `rg --json` stdout into flat match records, in output order. */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("grep received malformed ripgrep --json output (a line is not JSON)");
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { type?: string; data?: Record<string, unknown> };
    if (record.type !== "match") continue;
    const data = record.data;
    if (typeof data !== "object" || data === null)
      throw new Error("grep received malformed ripgrep --json output (a match record has no data)");
    const pathText =
      typeof data.path === "object" && data.path !== null && "text" in data.path
        ? (data.path as { text?: unknown }).text
        : undefined;
    if (typeof pathText !== "string")
      throw new Error("grep received malformed ripgrep --json output (a match record has no path text)");
    if (typeof data.line_number !== "number")
      throw new Error("grep received malformed ripgrep --json output (a match record has no line number)");
    const lines = data.lines as { text?: unknown; bytes?: unknown } | undefined;
    if (typeof lines === "object" && lines !== null && typeof lines.text === "string") {
      matches.push({
        path: pathText,
        lineNumber: data.line_number,
        line: lines.text.replace(/\r?\n$/, ""),
      });
    } else if (typeof lines === "object" && lines !== null && typeof lines.bytes === "string") {
      matches.push({ path: pathText, lineNumber: data.line_number, line: "(line is not valid UTF-8)" });
    } else {
      throw new Error("grep received malformed ripgrep --json output (a match record has neither line text nor bytes)");
    }
  }
  return matches;
}

/** Bound one matched-line preview to `maxBytes`, preserving UTF-8 boundaries. */
export function previewGrepLine(line: string, maxBytes = GREP_MAX_LINE_BYTES): string {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.byteLength <= maxBytes) return line;
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return `${buffer.subarray(0, cut).toString("utf8")} (line truncated)`;
}

export type RetainedMatches = { items: GrepMatch[]; kept: number; seen: number; truncated: boolean };

/** Apply the inline match cap and per-line preview budget (SPEC §1: 250 matches). */
export function retainGrepMatches(
  matches: readonly GrepMatch[],
  maxMatches = GREP_MAX_MATCHES,
  maxLineBytes = GREP_MAX_LINE_BYTES,
): RetainedMatches {
  const items = matches.slice(0, maxMatches).map((match) => ({
    ...match,
    line: previewGrepLine(match.line, maxLineBytes),
  }));
  return {
    items,
    kept: items.length,
    seen: matches.length,
    truncated: matches.length > maxMatches,
  };
}

/** Group flat matches by file (first-seen order): path, then `Line N: <text>` rows. */
export function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group !== undefined) group.push(match);
    else byFile.set(match.path, [match]);
  }
  const sections: string[] = [];
  for (const [path, group] of byFile)
    sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join("\n")}`);
  return sections.join("\n\n");
}

/** Format the model-facing `grep` result: header, grouped body, capped footer. */
export function formatGrepOutput(retained: RetainedMatches): string {
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${retained.seen === 1 ? "match" : "matches"}`;
  const body = formatGrepMatches(retained.items);
  if (!retained.truncated) return `${header}\n\n${body}`;
  return `${header}\n\n${body}\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)`;
}

// ---------------------------------------------------------------------------
// ls (SPEC §1: case-insensitive alphabetical, dir '/', dotfiles, 500/50KB caps)
// ---------------------------------------------------------------------------

export const LS_DEFAULT_LIMIT = 500;
export const LS_MAX_BYTES = 50 * 1024;

export function formatLsSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build the `ls` result text from sorted, suffix-attached entries: cap at
 * `limit` entries, then at LS_MAX_BYTES output bytes (dropping trailing whole
 * lines), and append the stock pi-style notice line when either cap hit
 * (SPEC §1). An empty entry list renders `(empty directory)`.
 */
export function buildLsOutput(entries: readonly string[], limit: number): string {
  if (entries.length === 0) return "(empty directory)";
  const notices: string[] = [];
  let kept = entries.slice(0, limit);
  if (entries.length > limit)
    notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
  if (Buffer.byteLength(kept.join("\n"), "utf8") > LS_MAX_BYTES) {
    while (kept.length > 0 && Buffer.byteLength(kept.join("\n"), "utf8") > LS_MAX_BYTES) kept.pop();
    notices.push(`${formatLsSize(LS_MAX_BYTES)} limit reached`);
  }
  const text = kept.join("\n");
  return notices.length === 0 ? text : `${text}\n\n[${notices.join(". ")}]`;
}

/** Sort key: case-insensitive alphabetical (SPEC §1). */
export function compareLsEntries(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

// ---------------------------------------------------------------------------
// bash (SPEC §4: 64000-byte combined cap, spill)
// ---------------------------------------------------------------------------

export const BASH_MAX_OUTPUT_BYTES = 64000;
export const BASH_DEFAULT_TIMEOUT_MS = 120000;
export const BASH_MAX_TIMEOUT_MS = 600000;

/**
 * Cap stdout+stderr to a combined byte budget (SPEC §4): stdout is retained
 * first, stderr gets the remainder. `truncated` reports whether either stream
 * lost bytes.
 */
export function capBashStreams(
  stdout: Buffer,
  stderr: Buffer,
  maxTotal = BASH_MAX_OUTPUT_BYTES,
): { stdout: Buffer; stderr: Buffer; truncated: boolean } {
  const cappedStdout = stdout.subarray(0, maxTotal);
  const cappedStderr = stderr.subarray(0, Math.max(0, maxTotal - cappedStdout.byteLength));
  return {
    stdout: cappedStdout,
    stderr: cappedStderr,
    truncated:
      cappedStdout.byteLength < stdout.byteLength || cappedStderr.byteLength < stderr.byteLength,
  };
}

/** Suggested spill file name for one stream of one call. */
export function bashSpillFile(callId: string, stream: "stdout" | "stderr"): string {
  return `${callId || "call"}-${stream}.txt`;
}
