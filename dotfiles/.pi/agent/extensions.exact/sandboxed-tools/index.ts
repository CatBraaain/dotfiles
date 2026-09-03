import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function isImageFile(imagePath: string, detectedMimeType = imageMimeType(imagePath)): boolean {
  return detectedMimeType === null
    ? IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())
    : detectedMimeType.startsWith("image/");
}

const OCR_GENERATION_NOTE = [
  "このテキストはOCR抽出であり、原画像ではなく抽出誤りを含みうる。",
  "金額、日付、固有名詞、契約・法的文言のいずれかが含まれる場合は、原画像との照合をオーナーに依頼すること。",
  "",
].join("\n");

function findFirstMarkdown(directory: string): string | undefined {
  const entries = [...readdirSync(directory, { withFileTypes: true })].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstMarkdown(fullPath);
      if (found !== undefined) return found;
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      return fullPath;
    }
  }
  return undefined;
}

function runMineru(
  imagePath: string,
): { ok: true; markdown: string } | { ok: false; message: string } {
  const outputDirectory = mkdtempSync(join(tmpdir(), "sandboxed-tools-mineru-"));
  try {
    const result = spawnSync(
      "mineru",
      ["-p", imagePath, "-o", outputDirectory, "-m", "ocr", "-b", "pipeline"],
      { encoding: "utf8", env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" } },
    );
    if (result.error) {
      const reason =
        (result.error as NodeJS.ErrnoException).code === "ENOENT"
          ? "mineru is not installed"
          : result.error.message;
      return { ok: false, message: `MinerU execution failed: ${reason}` };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      return { ok: false, message: `MinerU exited with status ${result.status}: ${stderr}` };
    }
    const markdownPath = findFirstMarkdown(outputDirectory);
    if (markdownPath === undefined) {
      return { ok: false, message: "MinerU produced no markdown output" };
    }
    return { ok: true, markdown: readFileSync(markdownPath, "utf8") };
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

const OCR_CACHE_VERSION = "v1";

function isPathWithin(path: string, parent: string): boolean {
  const relativePath = relative(parent, path);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function ocrCacheRoot(imagePath: string): string {
  const defaultCacheRoot = join(process.env.HOME || homedir(), ".cache");
  const configuredCacheRoot = process.env.XDG_CACHE_HOME;
  if (!configuredCacheRoot) return defaultCacheRoot;

  const resolvedCacheRoot = resolve(configuredCacheRoot);
  const isWithinProject = isPathWithin(resolvedCacheRoot, process.cwd());
  const isAdjacentToImage = isPathWithin(resolvedCacheRoot, dirname(imagePath));
  return isWithinProject || isAdjacentToImage ? defaultCacheRoot : resolvedCacheRoot;
}

function imageOcrCachePath(imagePath: string): string {
  const imageHash = createHash("sha256").update(readFileSync(imagePath)).digest("hex");
  return join(
    ocrCacheRoot(imagePath),
    "pi",
    "sandboxed-tools",
    "ocr",
    OCR_CACHE_VERSION,
    `${imageHash}.md`,
  );
}

function createImageReadResult(imagePath: string): {
  content: [{ type: "text"; text: string }];
  details: { generated: boolean };
} {
  const cachePath = imageOcrCachePath(imagePath);
  if (existsSync(cachePath)) {
    return {
      content: [{ type: "text", text: readFileSync(cachePath, "utf8") }],
      details: { generated: false },
    };
  }

  const mineru = runMineru(imagePath);
  if (!mineru.ok) throw new Error(mineru.message);

  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  writeFileSync(cachePath, mineru.markdown, { encoding: "utf8", mode: 0o600 });
  return {
    content: [{ type: "text", text: OCR_GENERATION_NOTE + mineru.markdown }],
    details: { generated: true },
  };
}

/** Append the EROFS guidance to the bash tool result so the model sees it at failure time. */
function appendErofsHint(result: AgentToolResult<any>): AgentToolResult<any> {
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (!text.includes("Read-only file system")) return result;
  return { ...result, content: [...result.content, { type: "text", text: EROFS_HINT }] };
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
      description: `${readTool.description} Images are internally processed by OCR or image analysis and returned only as text. Layout, appearance, color, and other non-text information are unavailable. Image binary is never automatically attached as Vision input.`,
    },
    "read",
    (args) => args.path,
    async (args, signal, context) => {
      const imagePath = resolve(cwd, args.path);
      await sandbox.authorizePath("read", imagePath, context);
      if (isImageFile(imagePath)) return createImageReadResult(imagePath);
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
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("find", args, { mode: "fs", signal });
    },
  );
  registerTextTool(
    lsTool,
    "ls",
    (args) => formatPath(String(args.path ?? ""), cwd),
    async (args, signal, context) => {
      await sandbox.authorizePath("read", resolve(cwd, args.path ?? "."), context);
      return sandbox.runTool("ls", args, { mode: "fs", signal });
    },
  );
}
