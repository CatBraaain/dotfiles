// sandboxed-tools runner — the helper that executes INSIDE the bwrap sandbox
// (SPEC §7). One invocation reads one JSON request from stdin (tool name,
// params, options), performs that tool's file/process IO with plain node
// builtins, and writes the result as one JSON envelope on stdout:
//   {"ok":true,"result":{...}} | {"ok":false,"error":"..."}
//
// The host plugin (src/sandbox.ts Sandbox.runTool) spawns this file as
// `node <plugin>/dist/runner.js` inside a single bwrap invocation per tool
// call. The stock dsh fs/bash tool packages cannot be executed this way (they
// resolve their IO through ctx services), so the IO itself lives here. This
// file must stay dependency-free (node builtins + ./io-core.ts only) so the
// built dist/runner.js runs inside the sandbox with just the dist directory
// ro-bound.
//
// Every path parameter arrives already normalized and absolute (SPEC §3: the
// reviewed path is the executed path), so this file performs no `~`/cwd
// resolution except where noted (glob/grep search roots use the sandbox cwd,
// which the host sets to the resolved search directory).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  applyEditLiteral,
  bashSpillFile,
  buildGlobArgv,
  buildGrepArgv,
  buildLsOutput,
  buildReadWindow,
  capBashStreams,
  compareLsEntries,
  parseGrepMatches,
  sniffImageMediaType,
  validateGrepInclude,
} from "./io-core";

export type RunnerToolName = "read" | "write" | "edit" | "glob" | "grep" | "ls" | "bash";

/** The stdin request envelope (host → runner). */
export type RunnerRequest = {
  tool: RunnerToolName;
  params: Record<string, unknown>;
  options?: {
    /** Observed mtime (§2.4): write/edit refuse an unread or changed file. */
    observedMtimeMs?: number;
    /** Write only (§2.4): the §6.1 File-only approval guarantee just created
     * the target as an empty placeholder file, so the first write succeeds as
     * create without a prior read. Non-empty unread files stay refused. */
    approvalCreatedFile?: boolean;
    /** Effective bash timeout (already clamped to the §4 cap by the host). */
    bashTimeoutMs?: number;
    /** Writable spill directory (bound into the sandbox) for capped bash output. */
    spillDir?: string;
    /** Absolute path of the ripgrep binary (its directory is ro-bound). */
    rgPath?: string;
    /** Call identity for spill file naming. */
    callId?: string;
  };
};

export type RunnerReadResult = {
  path: string;
  offset: number;
  lines: { number: number; text: string }[];
  totalLines: number;
  mtimeMs: number;
};
export type RunnerWriteResult = { path: string; operation: "create" | "update"; mtimeMs: number };
export type RunnerEditResult = { path: string; replacements: number; mtimeMs: number };
export type RunnerGlobResult = { paths: string[] };
export type RunnerGrepResult = { matches: { path: string; lineNumber: number; line: string }[] };
export type RunnerLsResult = { path: string; text: string };
export type RunnerImageBytesResult = { path: string; dataBase64: string; mediaType: string };
export type RunnerBashResult = {
  stdout: { text: string; truncated: boolean; spillPath?: string };
  stderr: { text: string; truncated: boolean; spillPath?: string };
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMs: number;
};

export type RunnerResponse =
  | {
      ok: true;
      result:
        | RunnerReadResult
        | RunnerWriteResult
        | RunnerEditResult
        | RunnerGlobResult
        | RunnerGrepResult
        | RunnerLsResult
        | RunnerImageBytesResult
        | RunnerBashResult;
    }
  | { ok: false; error: string };

const RAW_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
const HAS_NOT_BEEN_READ = (path: string): string =>
  `cannot modify "${path}": file has not been read — read the file, then retry`;
const HAS_CHANGED = (path: string): string =>
  `cannot modify "${path}": file has changed since it was last read — re-read the file, then retry`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string when given`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireRegularFile(path: string): void {
  if (!existsSync(path)) throw new Error(`cannot read "${path}": not found`);
  if (!statSync(path).isFile()) throw new Error(`cannot read "${path}": not a regular file`);
}

// ---------------------------------------------------------------------------
// fs tools
// ---------------------------------------------------------------------------

/** §2.1: the read helper detects images signature-first (extension only
 * assists), so the host's single `read` tool serves text and images. Image
 * reads ignore offset/limit per §2.1. */
function runRead(params: Record<string, unknown>): RunnerReadResult | RunnerImageBytesResult {
  const filePath = requiredString(params.file_path, "file_path");
  requireRegularFile(filePath);
  const data = readFileSync(filePath);
  const mediaType = sniffImageMediaType(data);
  if (mediaType !== undefined)
    return { path: filePath, dataBase64: data.toString("base64"), mediaType };
  const offset = params.offset === undefined ? 1 : positiveInteger(params.offset, "offset");
  const limit = params.limit === undefined ? 2000 : positiveInteger(params.limit, "limit");
  if (limit > 2000) throw new Error("limit must be less than or equal to 2000");
  const window = buildReadWindow(data.toString("utf8"), offset, limit);
  return {
    path: filePath,
    offset,
    lines: window.lines,
    totalLines: window.totalLines,
    mtimeMs: statSync(filePath).mtimeMs,
  };
}

/** Enforce the §2.4 gate inside the sandbox: the last line of defense after
 * the host-side observation check, covering changes between check and write. */
function assertUnchangedSinceRead(
  path: string,
  observedMtimeMs: number | undefined,
  requireObserved: boolean,
  allowUnreadPlaceholder = false,
): void {
  if (!existsSync(path)) {
    if (requireObserved) throw new Error(`cannot modify "${path}": not found`);
    return;
  }
  const current = statSync(path).mtimeMs;
  if (observedMtimeMs === undefined) {
    // §2.4: an unread write is only allowed against the empty placeholder
    // that the §6.1 File-only approval guarantee just created.
    if (allowUnreadPlaceholder && statSync(path).size === 0) return;
    throw new Error(HAS_NOT_BEEN_READ(path));
  }
  if (observedMtimeMs !== current) throw new Error(HAS_CHANGED(path));
}

function runWrite(
  params: Record<string, unknown>,
  observedMtimeMs: number | undefined,
  approvalCreatedFile: boolean,
): RunnerWriteResult {
  const filePath = requiredString(params.file_path, "file_path");
  if (typeof params.content !== "string") throw new Error("content must be a string");
  assertUnchangedSinceRead(filePath, observedMtimeMs, false, approvalCreatedFile);
  // Overwriting the unread empty placeholder is a create, not an update: the
  // file only exists because the approval guarantee put it there (§6.1).
  const placeholderOverwrite = approvalCreatedFile && observedMtimeMs === undefined;
  const operation: "create" | "update" =
    placeholderOverwrite || !existsSync(filePath) ? "create" : "update";
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, params.content);
  return { path: filePath, operation, mtimeMs: statSync(filePath).mtimeMs };
}

function runEdit(
  params: Record<string, unknown>,
  observedMtimeMs: number | undefined,
): RunnerEditResult {
  const filePath = requiredString(params.file_path, "file_path");
  const oldString = requiredString(params.old_string, "old_string");
  if (typeof params.new_string !== "string") throw new Error("new_string must be a string");
  if (oldString === params.new_string) throw new Error("old_string and new_string must differ");
  const replaceAll = params.replace_all === undefined ? false : params.replace_all === true;
  assertUnchangedSinceRead(filePath, observedMtimeMs, true);
  const edited = applyEditLiteral(
    readFileSync(filePath, "utf8"),
    oldString,
    params.new_string,
    replaceAll,
    filePath,
  );
  writeFileSync(filePath, edited.content);
  return { path: filePath, replacements: edited.replacements, mtimeMs: statSync(filePath).mtimeMs };
}

function runLs(params: Record<string, unknown>): RunnerLsResult {
  const rawPath = optionalString(params.path, "path");
  const limit = params.limit === undefined ? 500 : positiveInteger(params.limit, "limit");
  const directory = rawPath === undefined ? process.cwd() : rawPath;
  if (!existsSync(directory)) throw new Error(`cannot list "${directory}": not found`);
  if (!statSync(directory).isDirectory())
    throw new Error(`cannot list "${directory}": not a directory`);
  const entries: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    let suffix = "";
    try {
      if (statSync(`${directory}/${entry.name}`).isDirectory()) suffix = "/";
    } catch {
      continue;
    }
    entries.push(entry.name + suffix);
  }
  entries.sort(compareLsEntries);
  return { path: directory, text: buildLsOutput(entries, limit) };
}

// ---------------------------------------------------------------------------
// rg-backed search tools (glob / grep)
// ---------------------------------------------------------------------------

type RgRun = { stdout: string; noMatches: boolean };

function runRipgrep(
  rgPath: string | undefined,
  argv: string[],
  cwd: string,
  toolName: string,
): Promise<RgRun> {
  if (rgPath === undefined)
    throw new Error(`${toolName} is unavailable: the ripgrep binary was not resolved`);
  return new Promise<RgRun>((resolveRun, rejectRun) => {
    const child = spawn(rgPath, ["--no-config", ...argv], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= RAW_OUTPUT_MAX_BYTES) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < 65536) stderrText += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      rejectRun(new Error(`${toolName} could not start its search command: ${String(error)}`)),
    );
    child.on("close", (exitCode) => {
      if (stdoutBytes > RAW_OUTPUT_MAX_BYTES) {
        rejectRun(
          new Error(
            `${toolName} produced ${stdoutBytes} bytes of raw output, over the ${RAW_OUTPUT_MAX_BYTES}-byte cap; narrow pattern, path, or include and retry`,
          ),
        );
        return;
      }
      if (exitCode === 1) {
        resolveRun({ stdout: "", noMatches: true });
        return;
      }
      if (exitCode !== 0) {
        const stderr = stderrText.trim();
        if (/regex parse error|error parsing glob/i.test(stderr))
          rejectRun(new Error(`${toolName} pattern rejected by ripgrep: ${stderr}`));
        else
          rejectRun(
            new Error(
              `${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ""}`,
            ),
          );
        return;
      }
      resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), noMatches: false });
    });
  });
}

/**
 * The search root for one glob/grep call (SPEC §1: results are relative to
 * it). A file path makes its directory the root with the file as the rg
 * target; a directory (or no path) searches that directory as cwd.
 */
function resolveSearchRoot(rawPath: string | undefined): { searchRoot: string; target?: string } {
  if (rawPath === undefined) return { searchRoot: process.cwd() };
  if (!existsSync(rawPath)) throw new Error(`cannot search "${rawPath}": not found`);
  if (statSync(rawPath).isDirectory()) return { searchRoot: rawPath };
  return { searchRoot: dirname(rawPath), target: basename(rawPath) };
}

async function runGlob(
  params: Record<string, unknown>,
  rgPath: string | undefined,
): Promise<RunnerGlobResult> {
  const pattern = requiredString(params.pattern, "pattern");
  const rawPath = optionalString(params.path, "path");
  const { searchRoot, target } = resolveSearchRoot(rawPath);
  const argv = buildGlobArgv(pattern);
  if (target !== undefined) argv.push("--", target);
  const run = await runRipgrep(rgPath, argv, searchRoot, "glob");
  if (run.noMatches) return { paths: [] };
  return { paths: run.stdout.split("\n").filter((line) => line.length > 0) };
}

async function runGrep(
  params: Record<string, unknown>,
  rgPath: string | undefined,
): Promise<RunnerGrepResult> {
  if (typeof params.pattern !== "string" || params.pattern.length === 0)
    throw new Error("pattern must be a non-empty string");
  const rawPath = optionalString(params.path, "path");
  const include = optionalString(params.include, "include");
  if (include !== undefined) validateGrepInclude(include);
  const { searchRoot, target } = resolveSearchRoot(rawPath);
  const argv = buildGrepArgv(params.pattern, include);
  if (target !== undefined) argv.push("--", target);
  const run = await runRipgrep(rgPath, argv, searchRoot, "grep");
  if (run.noMatches) return { matches: [] };
  return { matches: parseGrepMatches(run.stdout) };
}

// ---------------------------------------------------------------------------
// bash (SPEC §4)
// ---------------------------------------------------------------------------

async function runBash(
  params: Record<string, unknown>,
  options: NonNullable<RunnerRequest["options"]>,
): Promise<RunnerBashResult> {
  const command = requiredString(params.command, "command");
  if (params.workdir !== undefined) optionalString(params.workdir, "workdir");
  const requested =
    params.timeoutMs === undefined ? undefined : positiveInteger(params.timeoutMs, "timeoutMs");
  const timeoutMs = Math.min(
    requested ?? options.bashTimeoutMs ?? BASH_DEFAULT_TIMEOUT_MS,
    BASH_MAX_TIMEOUT_MS,
  );
  const workdir = params.workdir === undefined ? process.cwd() : (params.workdir as string);
  return await new Promise<RunnerBashResult>((resolveRun, rejectRun) => {
    const child = spawn("bash", ["-c", command], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectRun(new Error(`bash could not start: ${String(error)}`));
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const fullStdout = Buffer.concat(stdout);
      const fullStderr = Buffer.concat(stderr);
      const capped = capBashStreams(fullStdout, fullStderr);
      const stdoutPart: RunnerBashResult["stdout"] = {
        text: capped.stdout.toString("utf8"),
        truncated: capped.stdout.byteLength < fullStdout.byteLength,
      };
      const stderrPart: RunnerBashResult["stderr"] = {
        text: capped.stderr.toString("utf8"),
        truncated: capped.stderr.byteLength < fullStderr.byteLength,
      };
      if (options.spillDir !== undefined && options.callId !== undefined) {
        try {
          mkdirSync(options.spillDir, { recursive: true });
          if (stdoutPart.truncated) {
            const path = `${options.spillDir}/${bashSpillFile(options.callId, "stdout")}`;
            writeFileSync(path, fullStdout);
            stdoutPart.spillPath = path;
          }
          if (stderrPart.truncated) {
            const path = `${options.spillDir}/${bashSpillFile(options.callId, "stderr")}`;
            writeFileSync(path, fullStderr);
            stderrPart.spillPath = path;
          }
        } catch {
          // Spill is best-effort: a failed save keeps the (unavailable) marker.
        }
      }
      resolveRun({
        stdout: stdoutPart,
        stderr: stderrPart,
        exitCode,
        signal,
        timedOut,
        timeoutMs,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// dispatch + main
// ---------------------------------------------------------------------------

export async function executeRequest(
  request: RunnerRequest,
): Promise<Exclude<RunnerResponse, { ok: false }>["result"]> {
  const options = request.options ?? {};
  switch (request.tool) {
    case "read":
      return runRead(request.params);
    case "write":
      return runWrite(request.params, options.observedMtimeMs, options.approvalCreatedFile === true);
    case "edit":
      return runEdit(request.params, options.observedMtimeMs);
    case "glob":
      return await runGlob(request.params, options.rgPath);
    case "grep":
      return await runGrep(request.params, options.rgPath);
    case "ls":
      return runLs(request.params);
    case "bash":
      return await runBash(request.params, options);
    default:
      throw new Error(`Unknown tool: ${String((request as { tool?: unknown }).tool)}`);
  }
}

if (import.meta.main) {
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as RunnerRequest;
    const result = await executeRequest(request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
