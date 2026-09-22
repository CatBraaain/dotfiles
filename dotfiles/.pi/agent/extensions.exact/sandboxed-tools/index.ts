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
import { modelSupportsImages } from "../shared/image-input.ts";
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

/** §2.3 approval note for a write grant approved via a confirmation dialog.
 * Unset paths become writable including via bash; ask-final paths stay
 * read-only in the bash sandbox (§6.1), which the note spells out. */
export function writeApprovalNote(approval: PathApproval): string {
  if (approval.bashWritable === false)
    return approval.scope === "directory"
      ? `User approved write access via confirmation (scope: directory ${approval.grantedPath}); the subtree is writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).`
      : `User approved write access via confirmation (scope: file ${approval.grantedPath}); writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).`;
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

function isVisionImageFile(
  imagePath: string,
  detectedMimeType = imageMimeType(imagePath),
): boolean {
  if (detectedMimeType === "image/svg+xml") return false;
  return detectedMimeType === null
    ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
    : detectedMimeType.startsWith("image/");
}

export { isVisionImageFile };

// SPEC §2.1: 画像に対する read は OCR せず、画像入力対応モデルでは Vision 入力を返す。
// 画像非対応モデルでは、画像をモデルへ送らず vision 子 agent への委譲を促す。
export function imageReadErrorMessage(
  imagePath: string,
  model?: { provider?: string; id?: string },
): string {
  const modelName =
    model?.provider && model?.id ? ` (${model.provider}/${model.id})` : "";
  return (
    `The current model${modelName} does not support image input; the image was not sent to the model. ` +
    `Delegate image reading to the vision agent via subagent: have the child read the image ` +
    `with read and report its observation as text. If you cannot spawn subagents, report ` +
    `that image reading is needed to the requester. Path: ${imagePath}`
  );
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

export default function sandboxedToolsExtension(pi: ExtensionAPI, configPath?: string): void {
  const cwd = process.cwd();
  const sandbox = new Sandbox(cwd, configPath);
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
      description:
        `${readTool.description} Image files are returned as Vision input when the current model supports image input. ` +
        `A model without image input gets an error that directs delegation to the vision agent instead.`,
    },
    "read",
    (args) => args.path,
    async (args, signal, context) => {
      const normalized = withNormalizedPath(args) as { path: string };
      const imagePath = resolve(cwd, normalized.path);
      await sandbox.authorizePath("read", imagePath, context);
      if (!isVisionImageFile(imagePath)) {
        return sandbox.runTool("read", normalized, { mode: "fs", signal });
      }
      const model = context?.model as { input?: readonly string[]; provider?: string; id?: string } | undefined;
      if (!modelSupportsImages(model ?? {})) {
        return {
          content: [{ type: "text", text: imageReadErrorMessage(imagePath, model) }],
          details: {},
          isError: true,
        };
      }
      const data = readFileSync(imagePath);
      const mimeType = imageMimeType(imagePath) ?? "application/octet-stream";
      return {
        content: [{ type: "image" as const, data: data.toString("base64"), mimeType }],
        details: {},
      };
    },
    { renderCall: (args, theme) => new Text(formatReadCall(args, cwd, theme), 0, 0) },
  );
  pi.registerTool({
    ...writeTool,
    description: `${writeTool.description} Writing to an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.`,
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
    description: `${editTool.description} Editing an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session. Paths resolving to ask in the config stay read-only in the bash sandbox.`,
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
      "Ask the user to grant write access to a directory subtree, or to approve a command rejected as requiring a reason. For a path: use it before starting edit-heavy work in a directory not yet writable (a worktree to create, or its parent directory); once approved, the subtree becomes writable for the rest of the session (paths resolving to ask in the config stay read-only in the bash sandbox). For a command: pass the exact rejected command; once approved, re-sending the same bash call runs it once without another dialog.",
    promptSnippet: "Ask the user for write access to a directory subtree or command approval",
    promptGuidelines: [
      "Before starting edit-heavy work in a directory that is not yet writable (e.g. a worktree outside the allowed paths), call ask_permission on the worktree directory or its parent so the user can approve it up front.",
      'When bash rejects a command with "Command requires a reason", call ask_permission with that exact command and a reason instead of rewriting the command.',
    ],
    // No Type.Union/anyOf here: some models (e.g. GLM-5.3-Flash) fail to generate
    // arguments for union schemas. See SPEC §3.
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Directory to request write access for. Absolute path (~ allowed); relative paths resolve against the current cwd. A file path requests its parent directory subtree.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description:
            'Exact command string that bash rejected with "Command requires a reason". Pass it verbatim; the approval lets this same command run once via bash.',
        }),
      ),
      reason: Type.String({
        description:
          "Why write access or command execution is needed. Shown to the user in the confirmation dialog as a decision hint; keep it to one or two sentences.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, context) {
      const hasPath = typeof params.path === "string";
      const hasCommand = typeof params.command === "string";
      if (hasPath === hasCommand) {
        throw new Error(
          'ask_permission requires exactly one of "path" or "command", plus "reason". ' +
            'Example: {"path": "/some/dir", "reason": "..."} or {"command": "git push", "reason": "..."}',
        );
      }
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
              bashWritable: outcome.bashWritable,
            })
          : outcome.status === "already granted"
            ? outcome.bashWritable
              ? `Already granted: ${outcome.grantedPath} is writable for the rest of the session, including via bash.`
              : `Already granted: ${outcome.grantedPath} is writable via fs tools, but not via bash.`
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

  // Warn once at session start about command patterns that failed regex
  // compilation and are therefore ignored (SPEC §6).
  pi.on("session_start", (_event, ctx) => {
    if (sandbox.invalidCommandPatterns.length === 0) return;
    const patterns = sandbox.invalidCommandPatterns.map((p) => JSON.stringify(p)).join(", ");
    ctx.ui.notify(
      `sandboxed-tools: ignoring invalid command regex patterns: ${patterns}`,
      "warning",
    );
  });
}
