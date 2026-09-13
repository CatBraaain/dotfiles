// Model-facing tool definitions for sandboxed-tools: the seven tools
// registered on the dsh tools waterfall — read / write / edit /
// glob / grep / ls / bash (SPEC §1) — plus ask_permission (§3). Every call
// passes the §2/§2.2/§4 authorization gate — with the §2.3 confirmation
// dialog for ask resolutions — then executes its IO inside one bwrap
// invocation via Sandbox.runTool + the in-sandbox runner (§7). Argument
// names, result envelopes, and truncation behavior follow the stock dsh tool
// packages (dsh-tool-fs / dsh-tool-fs-search / dsh-tool-bash) unless SPEC.md
// differs. Approved write/edit/bash calls carry the §2.3 approval note as
// the final line of the rendered result, after the §4 EROFS hint when both
// apply.

import { basename, resolve } from "node:path";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ImageMediaType } from "@deepseek-ai/dsh-attachment";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  formatEditOutput,
  formatGrepOutput,
  formatReadOutput,
  formatWriteOutput,
  renderGlobPaths,
  retainGrepMatches,
} from "./io-core";
import type {
  RunnerBashResult,
  RunnerEditResult,
  RunnerGlobResult,
  RunnerGrepResult,
  RunnerImageBytesResult,
  RunnerLsResult,
  RunnerReadResult,
  RunnerWriteResult,
} from "./runner";
import {
  Sandbox,
  normalizeToolPath,
  type CommandPermissionRequest,
  type ConfirmOptions,
  type PathApproval,
  type WritePermissionRequest,
} from "./sandbox";

/** §2.1 vision-delegation error text (the wording source of truth is here). */
export function imageReadErrorMessage(
  path: string,
  provider: string | undefined,
  model: string | undefined,
): string {
  const route = provider !== undefined && model !== undefined ? ` (${provider}/${model})` : "";
  return (
    `The current model route${route} does not accept image input, so the image was not read. ` +
    `Delegate image reading to a vision agent: call the subagent tool with the "vision" agent, ` +
    `have it read this image with read, and report its observation as text. ` +
    `If you cannot spawn subagents, report to the requester that reading this image is needed. Path: ${path}`
  );
}

/** §2.1 image envelope: the image rides the session's attachments, so the
 * tool result carries the post-normalization reference, not the bytes. */
export type ImageReadEnvelope = {
  path: string;
  image: {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
  };
};

// ---------------------------------------------------------------------------
// §2.3 approval notes and the §4 EROFS hint
// ---------------------------------------------------------------------------

/** §2.3 approval note for a write grant approved via a confirmation dialog. */
export function writeApprovalNote(approval: PathApproval): string {
  return approval.scope === "directory"
    ? `User approved write access via confirmation (scope: directory ${approval.grantedPath}); the subtree is writable for the rest of the session, including via bash.`
    : `User approved write access via confirmation (scope: file ${approval.grantedPath}); writable for the rest of the session, including via bash.`;
}

/** §2.3 approval note for a command confirmed through a dialog or a one-shot approval. */
export const COMMAND_APPROVAL_NOTE = "User approved this command via confirmation.";

/** §4 hint appended to a bash result containing a sandboxed write failure. */
export const EROFS_HINT =
  "Sandbox blocked this write. Do not retry with bash; call ask_permission to approve the directory subtree.";

/** Whether the bash stdout/stderr text reports a sandboxed write failure (§4). */
export function bashResultHasErofs(result: RunnerBashResult): boolean {
  return (
    result.stdout.text.includes("Read-only file system") ||
    result.stderr.text.includes("Read-only file system")
  );
}

/**
 * Notes appended to a finished bash result (§4・§2.3): the EROFS hint first,
 * then the approval note, so the note stays the final line.
 */
export function bashResultNotes(result: RunnerBashResult, commandApproved: boolean): string[] {
  const notes: string[] = [];
  if (bashResultHasErofs(result)) notes.push(EROFS_HINT);
  if (commandApproved) notes.push(COMMAND_APPROVAL_NOTE);
  return notes;
}

/**
 * The ask_permission result text (§3): granted / already granted / denied are
 * distinguishable, and approvals say what became possible.
 */
export function askPermissionOutcomeText(
  outcome: WritePermissionRequest | CommandPermissionRequest,
): string {
  if ("grantedPath" in outcome) {
    return outcome.status === "granted"
      ? writeApprovalNote({
          operation: "write",
          scope: "directory",
          grantedPath: outcome.grantedPath,
        })
      : outcome.status === "already granted"
        ? `Already granted: ${outcome.grantedPath} is writable for the rest of the session, including via bash.`
        : `User denied write access to ${outcome.grantedPath}.` +
          (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
  }
  return outcome.status === "granted"
    ? "User approved this command via ask_permission; re-send the same bash call to run it (one-shot)."
    : outcome.status === "already granted"
      ? `No approval needed: ${outcome.command} is allowed by config.`
      : `User denied this command.` +
        (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
}

/** The §2.4 message for an unread target (shared by write/edit). */
export const NOT_BEEN_READ = (path: string): string =>
  `cannot modify "${path}": file has not been read — read the file, then retry`;

// ---------------------------------------------------------------------------
// §2.4 read-before-write observations (session-scoped, read tool only)
// ---------------------------------------------------------------------------

/**
 * Tracks which paths the current session has read through this plugin's
 * `read` tool, keyed by the observed mtime (SPEC §2.4). `write` on an
 * existing file and every `edit` require an observation whose mtime still
 * matches; observations never survive a session.
 */
export class ReadObservations {
  private readonly bySession = new Map<string, Map<string, number>>();

  markRead(sessionKey: string, path: string, mtimeMs: number): void {
    this.sessionMap(sessionKey).set(path, mtimeMs);
  }

  observedMtime(sessionKey: string, path: string): number | undefined {
    return this.bySession.get(sessionKey)?.get(path);
  }

  clearSession(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  private sessionMap(sessionKey: string): Map<string, number> {
    const existing = this.bySession.get(sessionKey);
    if (existing !== undefined) return existing;
    const created = new Map<string, number>();
    this.bySession.set(sessionKey, created);
    return created;
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Per-execution sandbox context, resolved by the plugin entry (index.ts). */
export type SandboxToolContext = {
  sandbox: Sandbox;
  /** Session identity for §2.4 observations ("" when agentless). */
  sessionKey: string;
  /** The session cwd relative tool paths resolve against (§3). */
  cwd: string;
  callId: string;
  /** The §2.3 confirmation channel (userQuestions seam) for this execution. */
  confirm: ConfirmOptions;
};

export type SandboxToolDeps = {
  contextOf(exec: ToolRunContext): SandboxToolContext;
  observations: ReadObservations;
  /** Absolute path of the packaged ripgrep binary, when resolvable. */
  rgPath?: string;
  /** Writable spill directory for capped bash output (§4). */
  spillDir?: string;
};

/** Resolve + normalize one path argument the same way for gate and run (§3). */
function absolutePathOf(context: SandboxToolContext, rawPath: string): string {
  return resolve(context.cwd, normalizeToolPath(rawPath));
}

export function registerSandboxedTools(ctx: Context, deps: SandboxToolDeps): void {
  const runSandboxed = <T>(
    exec: ToolRunContext,
    request: Parameters<Sandbox["runTool"]>[0],
    options: Parameters<Sandbox["runTool"]>[1],
  ): Promise<T> => {
    const context = deps.contextOf(exec);
    request.options = {
      rgPath: deps.rgPath,
      spillDir: deps.spillDir,
      callId: context.callId,
      ...request.options,
    };
    return context.sandbox.runTool(request, options) as Promise<T>;
  };

  // §2.1 route gate: runs after the sandbox read has produced the image bytes
  // for file-signature detection, rejecting an image-incapable route with the
  // vision-delegation error before the image is returned as input (SPEC §2.1).
  const gateImageRoute = async (filePath: string, exec: ToolRunContext): Promise<void> => {
    const routed = exec.agent?.session.requestHeader()?.config;
    const provider = routed?.provider ?? exec.agent?.options.provider;
    const model = routed?.model ?? exec.agent?.options.model;
    const llm = ctx.get("llm");
    if (provider === undefined || model === undefined || llm === undefined)
      throw new Error(imageReadErrorMessage(filePath, provider, model));
    const modelInfo = await llm.resolveModelInfo(provider, model, exec.signal);
    if (modelInfo.inputModalities === undefined || !modelInfo.inputModalities.includes("image"))
      throw new Error(imageReadErrorMessage(filePath, provider, model));
  };

  // §2.1: normalize + persist the image through the attachments service and
  // return the envelope carrying the post-normalization reference.
  const saveImageAttachment = async (
    filePath: string,
    mediaType: string,
    bytes: RunnerImageBytesResult,
  ): Promise<ImageReadEnvelope> => {
    const attachments = ctx.get("attachments")!;
    const ref = await attachments.saveImage({
      data: Buffer.from(bytes.dataBase64, "base64"),
      mediaType: mediaType as ImageMediaType,
      name: basename(filePath),
    });
    return {
      path: bytes.path,
      image: {
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    };
  };

  // ---- read -------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: "read",
      description:
        "Read a UTF-8 text file and return line-numbered content. Use offset and limit to continue reading large files. Image files (PNG/JPEG/WebP/GIF) are returned as image input instead, and offset/limit does not apply to them; on a route without image input, reading an image returns an error that directs delegation to a vision agent via the subagent tool.",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Path to read; relative paths resolve against the session cwd.",
        },
        offset: {
          type: "number",
          description: "1-based first line to return. Defaults to 1. Not applied to image files.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of lines to return. Defaults to and caps at 2000. Not applied to image files.",
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                offset: { type: "integer", required: true },
                lines: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      number: { type: "integer", required: true },
                      text: { type: "string", required: true },
                    },
                  },
                },
                totalLines: { type: "integer", required: true },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                image: {
                  type: "object",
                  required: true,
                  additionalProperties: false,
                  properties: {
                    attachmentId: { type: "string", required: true },
                    mediaType: { type: "string", required: true },
                    bytes: { type: "integer", required: true },
                    width: { type: "integer", required: true },
                    height: { type: "integer", required: true },
                    name: { type: "string" },
                  },
                },
              },
            },
          ],
        },
        render: (_args, value): ContentBlock[] =>
          "image" in value
            ? [
                { type: "text", text: formatImageReadOutput(value.path, value.image) },
                {
                  type: "image",
                  attachment: {
                    attachmentId: value.image.attachmentId as never,
                    mediaType: value.image.mediaType as never,
                    bytes: value.image.bytes,
                    width: value.image.width,
                    height: value.image.height,
                    ...(value.image.name === undefined ? {} : { name: value.image.name }),
                  },
                },
              ]
            : [
                {
                  type: "text",
                  text: formatReadOutput(
                    value.path,
                    { lines: value.lines, totalLines: value.totalLines },
                    value.offset,
                  ),
                },
              ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const filePath = absolutePathOf(context, args.file_path);
        await context.sandbox.authorizePathWithConfirm("read", filePath, context.confirm);
        const result = await runSandboxed<RunnerReadResult | RunnerImageBytesResult>(
          exec,
          {
            tool: "read",
            params: {
              file_path: filePath,
              ...("offset" in args ? { offset: args.offset } : {}),
              ...("limit" in args ? { limit: args.limit } : {}),
            },
          },
          { mode: "fs", cwd: context.cwd, signal: exec.signal },
        );
        if ("dataBase64" in result) {
          await gateImageRoute(filePath, exec);
          return await saveImageAttachment(filePath, result.mediaType, result);
        }
        deps.observations.markRead(context.sessionKey, filePath, result.mtimeMs);
        return {
          path: result.path,
          offset: result.offset,
          lines: result.lines,
          totalLines: result.totalLines,
        };
      },
    }),
  );

  // ---- write ------------------------------------------------------------

  const writeEditGuidance =
    "Writing to an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session, including from bash.";

  ctx.tools.register(
    defineTool({
      name: "write",
      description: `Create or fully replace a UTF-8 text file. ${writeEditGuidance}`,
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Path to write; relative paths resolve against the session cwd.",
        },
        content: {
          type: "string",
          required: true,
          description: "Full UTF-8 text content to write.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            operation: { type: "string", required: true, enum: ["create", "update"] },
            note: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              formatWriteOutput(value.path, value.operation) +
              (value.note === undefined ? "" : `\n${value.note}`),
          },
        ],
      },
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const filePath = absolutePathOf(context, args.file_path);
        const approval = await context.sandbox.authorizePathWithConfirm(
          "write",
          filePath,
          context.confirm,
        );
        const observed = deps.observations.observedMtime(context.sessionKey, filePath);
        const approvalCreatedFile = approval?.createdFile === true;
        const result = await runSandboxed<RunnerWriteResult>(
          exec,
          {
            tool: "write",
            params: { file_path: filePath, content: args.content },
            ...(observed !== undefined || approvalCreatedFile
              ? {
                  options: {
                    ...(observed !== undefined ? { observedMtimeMs: observed } : {}),
                    ...(approvalCreatedFile ? { approvalCreatedFile: true } : {}),
                  },
                }
              : {}),
          },
          { mode: "fs", cwd: context.cwd, signal: exec.signal },
        );
        deps.observations.markRead(context.sessionKey, filePath, result.mtimeMs);
        return {
          path: result.path,
          operation: result.operation,
          ...(approval === undefined ? {} : { note: writeApprovalNote(approval) }),
        };
      },
    }),
  );

  // ---- edit -------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: "edit",
      description: `Edit an existing UTF-8 text file by replacing literal text. ${writeEditGuidance}`,
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Path to edit; relative paths resolve against the session cwd.",
        },
        old_string: {
          type: "string",
          required: true,
          description: "Literal text to replace. Must match exactly.",
        },
        new_string: {
          type: "string",
          required: true,
          description: "Literal replacement text. Use an empty string to delete the match.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace all matches. Defaults to false; when false, old_string must appear exactly once.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            replacements: { type: "integer", required: true },
            note: { type: "string" },
          },
        },
        render: (args, value) => [
          {
            type: "text",
            text:
              formatEditOutput(value.path, args.replace_all === true) +
              (value.note === undefined ? "" : `\n${value.note}`),
          },
        ],
      },
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const filePath = absolutePathOf(context, args.file_path);
        await context.sandbox.authorizePathWithConfirm("read", filePath, context.confirm);
        const approval = await context.sandbox.authorizePathWithConfirm(
          "write",
          filePath,
          context.confirm,
        );
        const observed = deps.observations.observedMtime(context.sessionKey, filePath);
        if (observed === undefined) throw new Error(NOT_BEEN_READ(filePath));
        const result = await runSandboxed<RunnerEditResult>(
          exec,
          {
            tool: "edit",
            params: {
              file_path: filePath,
              old_string: args.old_string,
              new_string: args.new_string,
              ...(args.replace_all === undefined ? {} : { replace_all: args.replace_all }),
            },
            options: { observedMtimeMs: observed },
          },
          { mode: "fs", cwd: context.cwd, signal: exec.signal },
        );
        deps.observations.markRead(context.sessionKey, filePath, result.mtimeMs);
        return {
          path: result.path,
          replacements: result.replacements,
          ...(approval === undefined ? {} : { note: writeApprovalNote(approval) }),
        };
      },
    }),
  );

  // ---- glob / grep --------------------------------------------------------

  const searchTimeoutMs = 30000;
  // The declared ToolDefinition.timeoutMs covers profiled deployments; the
  // outer timeout enforces the same §1 budget directly on the bwrap process
  // so the cap holds even without the timeout-policy plugin.
  const searchSafetyTimeoutMs = searchTimeoutMs + 5000;

  ctx.tools.register(
    defineTool({
      name: "glob",
      description:
        "Find files whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded), in modification-time order, relative to the search directory. Up to 100 paths come back.",
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description:
            'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth; include a separator to anchor the depth.',
        },
        path: {
          type: "string",
          description:
            "Directory to search in. Defaults to the session workspace; a relative path resolves against it.",
        },
      },
      timeoutMs: searchTimeoutMs,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            paths: { type: "array", required: true, items: { type: "string" } },
          },
        },
        render: (_args, value) => [{ type: "text", text: renderGlobPaths(value.paths) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const searchPath = args.path === undefined ? undefined : absolutePathOf(context, args.path);
        await context.sandbox.authorizePathWithConfirm(
          "read",
          searchPath ?? context.cwd,
          context.confirm,
        );
        const result = await runSandboxed<RunnerGlobResult>(
          exec,
          {
            tool: "glob",
            params: {
              pattern: args.pattern,
              ...(searchPath === undefined ? {} : { path: searchPath }),
            },
          },
          {
            mode: "fs",
            cwd: searchPath ?? context.cwd,
            signal: exec.signal,
            timeoutMs: searchSafetyTimeoutMs,
          },
        );
        return { paths: result.paths };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "grep",
      description:
        "Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file, relative to the search directory. Returns the first 250 matches inline.",
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description: "Regular expression to search for (ripgrep syntax).",
        },
        path: {
          type: "string",
          description:
            "File or directory to search. Defaults to the session workspace; a relative path resolves against it.",
        },
        include: {
          type: "string",
          description:
            'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
        },
      },
      timeoutMs: searchTimeoutMs,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matches: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  lineNumber: { type: "integer", required: true },
                  line: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          { type: "text", text: formatGrepOutput(retainGrepMatches(value.matches)) },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const searchPath = args.path === undefined ? undefined : absolutePathOf(context, args.path);
        await context.sandbox.authorizePathWithConfirm(
          "read",
          searchPath ?? context.cwd,
          context.confirm,
        );
        const result = await runSandboxed<RunnerGrepResult>(
          exec,
          {
            tool: "grep",
            params: {
              pattern: args.pattern,
              ...(searchPath === undefined ? {} : { path: searchPath }),
              ...(args.include === undefined ? {} : { include: args.include }),
            },
          },
          {
            mode: "fs",
            cwd: searchPath ?? context.cwd,
            signal: exec.signal,
            timeoutMs: searchSafetyTimeoutMs,
          },
        );
        return { matches: result.matches };
      },
    }),
  );

  // ---- ls ----------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: "ls",
      description:
        "List directory entries, sorted alphabetically (case-insensitive), with a '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
      parameters: {
        path: {
          type: "string",
          description:
            "Directory to list (default: the session cwd); a relative path resolves against it.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default: 500).",
        },
      },
      timeoutMs: searchTimeoutMs,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        const directory =
          args.path === undefined ? context.cwd : absolutePathOf(context, args.path);
        await context.sandbox.authorizePathWithConfirm("read", directory, context.confirm);
        const result = await runSandboxed<RunnerLsResult>(
          exec,
          {
            tool: "ls",
            params: { path: directory, ...(args.limit === undefined ? {} : { limit: args.limit }) },
          },
          { mode: "fs", cwd: context.cwd, signal: exec.signal },
        );
        return { path: result.path, text: result.text };
      },
    }),
  );

  // ---- bash --------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: "bash",
      description:
        'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands by other means; call ask_permission to approve the working directory subtree. Commands rejected with "Command requires a reason" must be re-requested via ask_permission with the same command and a reason; do not rewrite them to bypass the gate. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.',
      parameters: {
        command: { type: "string", required: true, description: "The bash command to execute." },
        description: {
          type: "string",
          required: true,
          description:
            "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds. Default 120000, capped at 600000.",
        },
        workdir: {
          type: "string",
          description:
            "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            stdout: {
              type: "object",
              required: true,
              additionalProperties: false,
              properties: {
                text: { type: "string", required: true },
                truncated: { type: "boolean", required: true },
                spillPath: { type: "string" },
              },
            },
            stderr: {
              type: "object",
              required: true,
              additionalProperties: false,
              properties: {
                text: { type: "string", required: true },
                truncated: { type: "boolean", required: true },
                spillPath: { type: "string" },
              },
            },
            exitCode: { required: true, oneOf: [{ type: "integer" }, { type: "null" }] },
            signal: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
            timedOut: { type: "boolean", required: true },
            timeoutMs: { type: "number", required: true },
            note: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: renderBashResult(value) + (value.note === undefined ? "" : `\n${value.note}`),
          },
        ],
      },
      async execute(args, exec) {
        if (args.command.trim().length === 0)
          throw new Error("invalid command: expected a non-empty string");
        if (args.description.trim().length === 0)
          throw new Error("invalid description: expected a non-empty string");
        if (
          args.timeoutMs !== undefined &&
          (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
        )
          throw new Error(
            `invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`,
          );
        const context = deps.contextOf(exec);
        const commandApproved = await context.sandbox.authorizeCommand(
          args.command,
          context.confirm,
        );
        const workdir =
          args.workdir === undefined ? context.cwd : absolutePathOf(context, args.workdir);
        const effectiveTimeoutMs = Math.min(
          args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS,
          BASH_MAX_TIMEOUT_MS,
        );
        const result = await runSandboxed<RunnerBashResult>(
          exec,
          {
            tool: "bash",
            params: { command: args.command, workdir, timeoutMs: effectiveTimeoutMs },
          },
          {
            mode: "bash",
            cwd: workdir,
            signal: exec.signal,
            timeoutMs: effectiveTimeoutMs + 60000,
          },
        );
        const notes = bashResultNotes(result, commandApproved);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          timeoutMs: result.timeoutMs,
          ...(notes.length === 0 ? {} : { note: notes.join("\n") }),
        };
      },
    }),
  );

  // ---- ask_permission -----------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: "ask_permission",
      description:
        "Ask the user to grant write access to a directory subtree, or to approve a command rejected as requiring a reason. " +
        "For a path: use it before starting edit-heavy work in a directory that is not yet writable (a worktree to create, or its parent directory); " +
        "once approved, the subtree becomes writable for the rest of the session, including from bash. " +
        'For a command: pass the exact command bash rejected with "Command requires a reason"; once approved, re-sending the same bash call runs it once without another dialog.',
      parameters: {
        path: {
          type: "string",
          description:
            "Directory to request write access for. Absolute path (~ allowed); relative paths resolve against the current cwd. A file path requests its parent directory subtree.",
        },
        command: {
          type: "string",
          description:
            'Exact command string that bash rejected with "Command requires a reason". Pass it verbatim; the approval lets this same command run once via bash.',
        },
        reason: {
          type: "string",
          required: true,
          description:
            "Why write access or command execution is needed. Shown to the user in the confirmation dialog as a decision hint; keep it to one or two sentences.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              required: true,
              enum: ["granted", "already granted", "denied"],
            },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const context = deps.contextOf(exec);
        // No anyOf/union here: some models fail to generate arguments for
        // union schemas (SPEC §3); exclusivity is enforced at execution time.
        const command = typeof args.command === "string" ? args.command : undefined;
        const path = typeof args.path === "string" ? args.path : undefined;
        if ((command !== undefined) === (path !== undefined))
          throw new Error(
            'ask_permission requires exactly one of "path" or "command", plus "reason". ' +
              'Example: {"path": "/some/dir", "reason": "..."} or {"command": "git push", "reason": "..."}',
          );
        const reason = args.reason.trim();
        if (command !== undefined) {
          const outcome = await context.sandbox.requestCommandPermission(
            command,
            reason,
            context.confirm,
          );
          return { status: outcome.status, text: askPermissionOutcomeText(outcome) };
        }
        const directoryPath = absolutePathOf(context, path as string);
        const outcome = await context.sandbox.requestWritePermission(
          directoryPath,
          reason,
          context.confirm,
        );
        return { status: outcome.status, text: askPermissionOutcomeText(outcome) };
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// §2.1 image read output formatting
// ---------------------------------------------------------------------------

/** Format the §2.1 image envelope beside the image block (stock wording). */
function formatImageReadOutput(
  path: string,
  image: { mediaType: string; bytes: number; width: number; height: number },
): string {
  return `<path>${path}</path>\n<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes\n</content>`;
}

/** Shape one finished bash run into the model-facing text (§4, stock wording). */
export function renderBashResult(result: RunnerBashResult): string {
  const streamText = (stream: { text: string; truncated: boolean; spillPath?: string }): string =>
    stream.truncated
      ? `${stream.text}\n[output truncated; full output: ${stream.spillPath ?? "(unavailable)"}]`
      : stream.text;
  let body = streamText(result.stdout);
  const err = streamText(result.stderr);
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) body = "(no output)";
  const markers: string[] = [];
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
  if (markers.length === 0) return body;
  if (!body.endsWith("\n")) body += "\n";
  return body + markers.join("\n");
}
