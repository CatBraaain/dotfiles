import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Sandbox, type PathApproval, type ToolSession } from "./sandbox";
import { normalizeToolPath } from "../shared/normalize-path.ts";
import {
  ASK_PERMISSION_TARGET_PREVIEW_LIMIT,
  formatBashCall,
  formatNamedCall,
  formatPath,
  formatReadCall,
  formatToolResultSummary,
  resultText,
  truncateText,
} from "../shared/tool-format.ts";

export {
  ASK_PERMISSION_TARGET_PREVIEW_LIMIT,
  COMMAND_PREVIEW_LIMIT,
  classifyReadPath,
  countMatchLines,
  countResultLines,
  formatDuration,
  formatSize,
  truncateText,
} from "../shared/tool-format.ts";

const ERROR_PREVIEW_LINE_LIMIT = 3;

function renderToolError(result: any, theme: any): Text {
  const errorLines = resultText(result).split(/\r?\n/);
  if (errorLines.at(-1) === "") errorLines.pop();
  const preview = errorLines.slice(0, ERROR_PREVIEW_LINE_LIMIT).join("\n");
  const hasMoreLines = errorLines.length > ERROR_PREVIEW_LINE_LIMIT;
  const displayText = hasMoreLines ? `${preview}\n…` : preview;
  return new Text(theme.fg("error", displayText), 0, 0);
}

function renderTextToolResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
  name: string,
): Text {
  if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
  if (context.isError) return renderToolError(result, theme);
  const summary = formatToolResultSummary(name, context.args ?? {}, result, {}, theme);
  return new Text(summary ?? "", 0, 0);
}

function sessionFromContext(context: any): ToolSession {
  return {
    sessionId: context?.sessionManager?.getSessionId?.(),
    sessionFile: context?.sessionManager?.getSessionFile?.(),
    provider: context?.model?.provider,
    modelId: context?.model?.id,
    reasoningLevel: context?.thinkingLevel,
  };
}

const EROFS_HINT =
  "Sandbox blocked this write. Do not retry with bash; call ask_permission to approve the directory subtree.";

const COMMAND_APPROVAL_NOTE = "User approved this command via confirmation.";

/** §2.3 approval note for a write grant approved via a confirmation dialog. */
export function writeApprovalNote(approval: PathApproval): string {
  return approval.scope === "directory"
    ? `User approved write access via confirmation (scope: directory ${approval.grantedPath}); the subtree is writable for the rest of the session, including via bash.`
    : `User approved write access via confirmation (scope: file ${approval.grantedPath}); writable for the rest of the session, including via bash.`;
}

/** Append a note as its own text block at the end of the final tool result (§2.3). */
function appendNote(result: AgentToolResult<any>, note: string): AgentToolResult<any> {
  return { ...result, content: [...result.content, { type: "text", text: note }] };
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
]);

function imageMimeType(path: string): string | null {
  const result = spawnSync("file", ["--brief", "--mime-type", "--", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function isImageFile(imagePath: string, detectedMimeType = imageMimeType(imagePath)): boolean {
  return detectedMimeType === null
    ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
    : detectedMimeType.startsWith("image/");
}

export { isImageFile };

// SPEC §2.1: 画像に対する read は OCR せず、vision の利用を促す。
export function imageReadErrorMessage(imagePath: string): string {
  return (
    `Image files are not readable via read. Image input is handled by the vision agent ` +
    `using the read_image tool. Switch the session to vision or delegate this image to ` +
    `vision. Path: ${imagePath}`
  );
}

// SPEC「画像入力を使う agent」: read_image は vision セッションでのみ Vision 入力を
// 作る。agents 拡張が親・子セッションへ PI_AGENT_NAME を設定する（applyAgentTools と
// runChild の env）。判定できない環境では拒否側に倒す。
export function isVisionAgentSession(context: unknown): boolean {
  const agentName =
    process.env.PI_AGENT_NAME ??
    (context !== null && typeof context === "object"
      ? (context as { agent?: unknown }).agent
      : undefined);
  return agentName === "vision";
}

/** Append the EROFS guidance to the bash tool result so the model sees it at failure time. */
function appendErofsHint(result: AgentToolResult<any>): AgentToolResult<any> {
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (!text.includes("Read-only file system")) return result;
  return { ...result, content: [...result.content, { type: "text", text: EROFS_HINT }] };
}

/**
 * Apply SPEC §3 path normalization to a tool-call `path` argument and return
 * params carrying the normalized path, so authorize and run-tools receive the
 * identical value (the reviewed path is the executed path). Params without a
 * usable path string are returned unchanged.
 */
function withNormalizedPath(params: { path?: unknown }): { path?: unknown } {
  if (typeof params.path !== "string" || params.path === "") return params;
  const normalized = normalizeToolPath(params.path);
  return normalized === params.path ? params : { ...params, path: normalized };
}

/**
 * Forward child stderr to onUpdate line-by-line (SPEC §7): each completed
 * non-empty line becomes a partial tool result so the UI shows progress while
 * the command runs. Bytes are buffered until a newline so multibyte UTF-8
 * split across chunks decodes as a complete sequence. stdout (the run-tools
 * JSON envelope) is not streamed, and the final result still returns once, at
 * completion.
 */
function stderrLineUpdater(
  onUpdate: (partialResult: AgentToolResult<any>) => void,
): (data: Buffer, stream: "stdout" | "stderr") => void {
  let pending = Buffer.alloc(0);
  return (data, stream) => {
    if (stream !== "stderr") return;
    pending = Buffer.concat([pending, data]);
    for (
      let newlineAt = pending.indexOf(0x0a);
      newlineAt !== -1;
      newlineAt = pending.indexOf(0x0a)
    ) {
      const line = pending.subarray(0, newlineAt).toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(newlineAt + 1);
      if (line !== "") onUpdate({ content: [{ type: "text", text: line }], details: {} });
    }
  };
}

export default function sandboxedToolsExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const sandbox = new Sandbox(cwd);
  const readTool = createReadTool(cwd);
  const writeTool = createWriteTool(cwd);
  const editTool = createEditTool(cwd);
  const grepTool = createGrepTool(cwd);
  const findTool = createFindTool(cwd);
  const lsTool = createLsTool(cwd);
  const bashTool = createBashTool(cwd);

  pi.registerTool({
    ...bashTool,
    description: `${bashTool.description} The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands with bash; call ask_permission to approve the working directory subtree. Commands rejected with "Command requires a reason" must be re-requested via ask_permission with the same command and a reason; do not rewrite them to bypass the gate.`,
    async execute(id, params, signal, onUpdate, context) {
      const approved = await sandbox.authorizeCommand(params.command, context);
      const result = await sandbox.runTool("bash", params, {
        mode: "bash",
        signal,
        session: sessionFromContext(context),
        onData: onUpdate === undefined ? undefined : stderrLineUpdater(onUpdate),
      });
      // The approval note follows other appended text, so it is the last line (§2.3).
      return approved
        ? appendNote(appendErofsHint(result), COMMAND_APPROVAL_NOTE)
        : appendErofsHint(result);
    },
    renderCall(args, theme, context) {
      if (context.state && context.executionStarted && context.state.startedAt === undefined)
        context.state.startedAt = Date.now();
      return new Text(formatBashCall(args.command, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        // While running, show the latest streamed stderr line as progress;
        // until the first line arrives this stays "Running..." (SPEC §7・§8).
        const progressLine = resultText(result);
        return new Text(
          theme.fg("warning", progressLine === "" ? "Running..." : progressLine),
          0,
          0,
        );
      }
      if (context.isError) return renderToolError(result, theme);
      const state = context.state;
      const durationMs =
        state?.startedAt !== undefined
          ? (state.endedAt ?? Date.now()) - state.startedAt
          : undefined;
      return new Text(
        formatToolResultSummary("bash", {}, result, { durationMs }, theme) ?? "",
        0,
        0,
      );
    },
  });

  const registerTextTool = (
    tool: any,
    name: string,
    getCall: (args: any) => string,
    run: (
      args: any,
      signal: AbortSignal | undefined,
      context: any,
    ) => Promise<AgentToolResult<any>>,
    renderOptions?: { renderCall?: (args: any, theme: any) => Text },
  ) => {
    pi.registerTool({
      ...tool,
      async execute(_id, params, signal, _onUpdate, context) {
        return run(params, signal, context);
      },
      renderCall(args: any, theme: any) {
        return (
          renderOptions?.renderCall?.(args, theme) ??
          new Text(formatNamedCall(name, getCall(args), theme), 0, 0)
        );
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        return renderTextToolResult(result, options, theme, context, name);
      },
    });
  };
  registerTextTool(
    {
      ...readTool,
      description: `${readTool.description} Image files cannot be read via read. Text extraction, appearance judgement, and layout work are handled by the vision agent using the read_image tool (Vision input); text-only agents cannot read images.`,
    },
    "read",
    (args) => args.path,
    async (args, signal, context) => {
      const normalized = withNormalizedPath(args) as { path: string };
      const imagePath = resolve(cwd, normalized.path);
      await sandbox.authorizePath("read", imagePath, context);
      if (isImageFile(imagePath)) throw new Error(imageReadErrorMessage(imagePath));
      return sandbox.runTool("read", normalized, { mode: "fs", signal });
    },
    { renderCall: (args, theme) => new Text(formatReadCall(args, cwd, theme), 0, 0) },
  );
  pi.registerTool({
    name: "read_image",
    label: "read_image",
    description:
      "Read an image file and return it as Vision input to the current model. Only the vision agent can use this tool: it is how the vision agent reads images for text extraction, appearance judgement, and layout work. Text-only agents cannot read images. The image is attached only to this agent's tool result and child session record, never to a parent agent.",
    promptSnippet: "Read an image file as Vision input (vision only)",
    promptGuidelines: [
      "Use read_image instead of read for image files: read rejects images and returns an error pointing here.",
      "Re-read an image with read_image after edits when the task depends on how the result looks (layout, appearance, color).",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file to read as Vision input" }),
    }),
    async execute(_id, params, signal, _onUpdate, context) {
      const normalized = withNormalizedPath(params) as { path: string };
      const imagePath = resolve(cwd, normalized.path);
      if (!isVisionAgentSession(context)) {
        return {
          content: [
            {
              type: "text",
              text: imageReadErrorMessage(imagePath),
            },
          ],
          details: {},
          isError: true,
        };
      }
      await sandbox.authorizePath("read", imagePath, context);
      if (!isImageFile(imagePath)) {
        throw new Error(`Not an image file: ${imagePath}`);
      }
      const data = readFileSync(imagePath);
      const mimeType = imageMimeType(imagePath) ?? "application/octet-stream";
      return {
        content: [{ type: "image" as const, data: data.toString("base64"), mimeType }],
        details: {},
      };
    },
    renderCall(args: any, theme: any) {
      return new Text(formatNamedCall("read_image", formatPath(args.path ?? "", cwd), theme), 0, 0);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return renderToolError(result, theme);
      const hasImage = Array.isArray(result.content) && result.content.some(
        (part: { type: string }) => part.type === "image",
      );
      return new Text(hasImage ? "image input" : "", 0, 0);
    },
  });
  pi.registerTool({
    ...writeTool,
    description: `${writeTool.description} Writing to an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session, including from bash.`,
    async execute(_id, params, signal, _onUpdate, context) {
      const normalized = withNormalizedPath(params) as { path: string };
      const approval = await sandbox.authorizePath("write", resolve(cwd, normalized.path), context);
      const result = await sandbox.runTool("write", normalized, { mode: "fs", signal });
      return approval === undefined ? result : appendNote(result, writeApprovalNote(approval));
    },
    renderCall(args, theme) {
      return new Text(formatNamedCall("write", formatPath(args.path, cwd), theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return renderToolError(result, theme);
      return new Text(
        formatToolResultSummary("write", context.args ?? {}, result, {}, theme) ?? "",
        0,
        0,
      );
    },
  });
  pi.registerTool({
    ...editTool,
    description: `${editTool.description} Editing an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session, including from bash.`,
    renderShell: "default",
    async execute(_id, params, signal, _onUpdate, context) {
      const normalized = withNormalizedPath(params) as { path: string };
      await sandbox.authorizePath("read", resolve(cwd, normalized.path), context);
      const approval = await sandbox.authorizePath("write", resolve(cwd, normalized.path), context);
      const result = await sandbox.runTool("edit", normalized, { mode: "fs", signal });
      return approval === undefined ? result : appendNote(result, writeApprovalNote(approval));
    },
    renderCall(args, theme) {
      return new Text(formatNamedCall("edit", formatPath(args.path, cwd), theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return renderToolError(result, theme);
      return new Text(
        formatToolResultSummary("edit", context.args ?? {}, result, {}, theme) ?? "",
        0,
        0,
      );
    },
  });
  pi.registerTool({
    ...grepTool,
    async execute(_id, params, signal, _onUpdate, context) {
      const normalized = withNormalizedPath(params) as { path?: string };
      await sandbox.authorizePath("read", resolve(cwd, normalized.path ?? "."), context);
      return sandbox.runTool("grep", normalized, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      const path = formatPath(String(args.path ?? ""), cwd);
      return new Text(formatNamedCall("grep", `${args.pattern} in ${path}`, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      if (context.isError) return renderToolError(result, theme);
      return new Text(
        formatToolResultSummary("grep", context.args ?? {}, result, {}, theme) ?? "",
        0,
        0,
      );
    },
  });
  registerTextTool(
    findTool,
    "find",
    (args) => `${args.pattern} in ${formatPath(String(args.path ?? ""), cwd)}`,
    async (args, signal, context) => {
      const normalized = withNormalizedPath(args) as { path?: string };
      await sandbox.authorizePath("read", resolve(cwd, normalized.path ?? "."), context);
      return sandbox.runTool("find", normalized, { mode: "fs", signal });
    },
  );
  registerTextTool(
    lsTool,
    "ls",
    (args) => formatPath(String(args.path ?? ""), cwd),
    async (args, signal, context) => {
      const normalized = withNormalizedPath(args) as { path?: string };
      await sandbox.authorizePath("read", resolve(cwd, normalized.path ?? "."), context);
      return sandbox.runTool("ls", normalized, { mode: "fs", signal });
    },
  );
  pi.registerTool({
    name: "ask_permission",
    label: "ask_permission",
    description:
      "Ask the user to grant write access to a directory subtree, or to approve a command rejected as requiring a reason. For a path: use it before starting edit-heavy work in a directory not yet writable (a worktree to create, or its parent directory); once approved, the subtree becomes writable for the rest of the session, including from bash. For a command: pass the exact rejected command; once approved, re-sending the same bash call runs it once without another dialog.",
    promptSnippet: "Ask the user for write access to a directory subtree or command approval",
    promptGuidelines: [
      "Before starting edit-heavy work in a directory that is not yet writable (e.g. a worktree outside the allowed paths), call ask_permission on the worktree directory or its parent so the user can approve it up front.",
      'When bash rejects a command with "Command requires a reason", call ask_permission with that exact command and a reason instead of rewriting the command.',
    ],
    parameters: Type.Union([
      Type.Object({
        path: Type.String({
          description:
            "Directory to request write access for. Absolute path (~ allowed); relative paths resolve against the current cwd. A file path requests its parent directory subtree.",
        }),
        reason: Type.String({
          description:
            "Why write access to this directory subtree is needed. Shown to the user in the confirmation dialog as a decision hint; keep it to one or two sentences.",
        }),
      }),
      Type.Object({
        command: Type.String({
          description:
            'Exact command string that bash rejected with "Command requires a reason". Pass it verbatim; the approval lets this same command run once via bash.',
        }),
        reason: Type.String({
          description:
            "Why this command is necessary. Shown to the user in the confirmation dialog as a decision hint; keep it to one or two sentences.",
        }),
      }),
    ]),
    async execute(_id, params, _signal, _onUpdate, context) {
      if (typeof params.command === "string") {
        const outcome = await sandbox.requestCommandPermission(
          params.command,
          params.reason.trim(),
          context,
        );
        const text =
          outcome.status === "granted"
            ? "User approved this command via ask_permission; re-send the same bash call to run it (one-shot)."
            : outcome.status === "already granted"
              ? `No approval needed: ${outcome.command} is allowed by config.`
              : `User denied this command.` +
                (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            status: outcome.status,
            command: outcome.command,
            ...(outcome.status === "denied" && outcome.reason !== undefined
              ? { reason: outcome.reason }
              : {}),
          },
        };
      }
      const normalized = withNormalizedPath(params) as { path: string };
      const outcome = await sandbox.requestWritePermission(
        resolve(cwd, normalized.path),
        params.reason.trim(),
        context,
      );
      const text =
        outcome.status === "granted"
          ? writeApprovalNote({
              operation: "write",
              scope: "directory",
              grantedPath: outcome.grantedPath,
            })
          : outcome.status === "already granted"
            ? `Already granted: ${outcome.grantedPath} is writable for the rest of the session, including via bash.`
            : `User denied write access to ${outcome.grantedPath}.` +
              (outcome.reason === undefined ? "" : `\nUser reason: ${outcome.reason}`);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: outcome.status,
          grantedPath: outcome.grantedPath,
          ...(outcome.status === "denied" && outcome.reason !== undefined
            ? { reason: outcome.reason }
            : {}),
        },
      };
    },
    renderCall(args: any, theme: any) {
      const target =
        typeof args.command === "string"
          ? truncateText(args.command, ASK_PERMISSION_TARGET_PREVIEW_LIMIT)
          : truncateText(
              formatPath(String(args.path ?? ""), cwd),
              ASK_PERMISSION_TARGET_PREVIEW_LIMIT,
            );
      return new Text(formatNamedCall("ask_permission", target, theme), 0, 0);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      return renderTextToolResult(result, options, theme, context, "ask_permission");
    },
  });
}
