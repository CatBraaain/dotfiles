import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
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
import { Sandbox, type ToolSession } from "./sandbox";
import {
  formatBashCall,
  formatNamedCall,
  formatPath,
  formatReadCall,
  formatToolResultSummary,
  resultText,
} from "../shared/tool-format.ts";

export {
  COMMAND_PREVIEW_LIMIT,
  classifyReadPath,
  countMatchLines,
  countResultLines,
  formatDuration,
  formatSize,
  truncateCommand,
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
  "Sandbox blocked this write. Do not retry with bash; call the write or edit tool on the target path to request access from the user.";

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

export function createImageReadBlockError(
  imagePath: string,
  detectedMimeType = imageMimeType(imagePath),
): Error | undefined {
  const isImage =
    detectedMimeType === null
      ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
      : detectedMimeType.startsWith("image/");
  if (!isImage) return undefined;

  const ocrPath = `${imagePath}.ocr.md`;
  const text = existsSync(ocrPath)
    ? [
        "IMAGE_BINARY_BLOCKED",
        "",
        "画像は直接読み込めない。",
        "抽出済みのOCRファイルを読み込むこと:",
        "",
        ocrPath,
      ].join("\n")
    : [
        "IMAGE_BINARY_BLOCKED",
        "",
        "画像バイナリの直接読み込みは禁止されている。",
        "画像の内容を読む場合は、AGENTS.mdの画像OCR手順に従うこと。",
        "",
        "1. 対応するOCRファイルを確認する:",
        `   ${ocrPath}`,
        "",
        "2. OCRファイルが存在しない場合:",
        "   AGENTS.mdに記載されたMinerU CLIを実行して作成する。",
        "",
        "3. 作成済みのOCRファイルをread toolで読み込む。",
        "",
        "元画像をVision入力へ自動添付してはならない。",
      ].join("\n");
  return new Error(text);
}

/** Append the EROFS guidance to the bash tool result so the model sees it at failure time. */
function appendErofsHint(result: AgentToolResult<any>): AgentToolResult<any> {
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (!text.includes("Read-only file system")) return result;
  return { ...result, content: [...result.content, { type: "text", text: EROFS_HINT }] };
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
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
    description: `${bashTool.description} The filesystem is sandboxed: writes outside approved paths fail with "Read-only file system". Do not retry such commands with bash; call the write or edit tool on the target path to request access from the user.`,
    async execute(id, params, signal, _onUpdate, context) {
      await sandbox.authorizeCommand(params.command, context);
      const result = await sandbox.runTool("bash", params, {
        mode: "bash",
        signal,
        session: sessionFromContext(context),
      });
      return appendErofsHint(result);
    },
    renderCall(args, theme, context) {
      if (context.state && context.executionStarted && context.state.startedAt === undefined)
        context.state.startedAt = Date.now();
      return new Text(formatBashCall(args.command, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
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
    run: (args: any, signal: AbortSignal | undefined, context: any) => Promise<AgentToolResult>,
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
    readTool,
    "read",
    (args) => args.path,
    async (args, signal, context) => {
      const imagePath = resolve(cwd, args.path);
      await sandbox.authorizePath("read", imagePath, context);
      const imageReadBlockError = createImageReadBlockError(imagePath);
      if (imageReadBlockError) throw imageReadBlockError;
      return sandbox.runTool("read", args, { mode: "fs", signal });
    },
    { renderCall: (args, theme) => new Text(formatReadCall(args, cwd, theme), 0, 0) },
  );
  pi.registerTool({
    ...writeTool,
    description: `${writeTool.description} Writing to an unapproved path prompts the user for permission; once approved, the path becomes writable for the rest of the session, including from bash.`,
    async execute(_id, params, signal, _onUpdate, context) {
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return sandbox.runTool("write", params, { mode: "fs", signal });
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
      await sandbox.authorizePath("read", resolve(cwd, params.path), context);
      await sandbox.authorizePath("write", resolve(cwd, params.path), context);
      return sandbox.runTool("edit", params, { mode: "fs", signal });
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
      await sandbox.authorizePath("read", resolve(cwd, params.path ?? "."), context);
      return sandbox.runTool("grep", params, { mode: "fs", signal });
    },
    renderCall(args, theme) {
      return new Text(formatNamedCall("grep", args.pattern, theme), 0, 0);
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
    (args) => args.pattern,
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("find", args, { mode: "fs", signal });
    },
  );
  registerTextTool(
    lsTool,
    "ls",
    (args) => args.path ?? ".",
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("ls", args, { mode: "fs", signal });
    },
  );
}
