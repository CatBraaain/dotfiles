/**
 * Openui Preview Extension
 *
 * Turns ```openui-lang fenced code blocks in finalized assistant messages into
 * PNG previews rendered inline in the TUI transcript. Blocks are parsed as
 * OpenUI Lang programs and rendered to self-contained HTML (see render.ts),
 * then shot once with the htmlshot CLI — generated DSL cannot carry scripts
 * or external references, so no unsafe retry is needed.
 *
 * Display-only markdown transformer: assistant bodies drop their
 * ```openui-lang blocks in the transcript (the preview card replaces them);
 * the message itself and the LLM context keep the blocks untouched.
 *
 * System prompt: a `openui-lang` section with display-only authoring
 * instructions is injected on every agent start (see prompt.ts).
 */

import { execFile as execFileCb } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text, type Component } from "@earendil-works/pi-tui";
import { extractOpuiLangBlocks, stripOpuiLangBlocks, type OpuiLangBlock } from "./fence";
import { PROMPT_SECTION_NAME, opuiInstructions } from "./prompt";
import { renderOpuiLang } from "./render";

export const OPENUI_CUSTOM_TYPE = "openui-preview";
/** Hard height limit for inline previews, in terminal cells. */
export const MAX_HEIGHT_CELLS = 30;
/** Viewport passed to htmlshot for the render. Tall enough for report-like UIs; the TUI scales it down to MAX_HEIGHT_CELLS. */
export const SHOT_WIDTH = 960;
export const SHOT_HEIGHT = 1280;

export interface PreviewDetails {
  kind: "image" | "error";
  pngPath?: string;
  message?: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => void;

export interface ExecFileError {
  code?: number | string;
  message: string;
}

export interface ShotOptions {
  outDir: string;
  htmlshotPath: string;
  execFile: ExecFileFn;
  width: number;
  height: number;
}

export interface ShotResult {
  ok: boolean;
  pngPath?: string;
  error?: string;
}

type EnqueueFn = <T>(task: () => Promise<T>) => Promise<T>;

interface ExtensionDeps extends ShotOptions {
  enqueue: EnqueueFn;
  /** Directory holding the generated spec.json / prompt-options.json. Defaults to this folder. */
  generatedDir?: string;
}

export function createQueue(): EnqueueFn {
  let chain: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

function run(
  execFile: ExecFileFn,
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function lastErrorLine(stderr: string): string {
  const lines = stderr.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "htmlshot failed";
}

/**
 * Renders one HTML document to <outDir>/<id>.html.png via the htmlshot CLI
 * (single strict attempt). The temporary HTML file is removed after the shot
 * because the PNG embeds the canonical HTML.
 */
export async function shotHtml(
  html: string,
  id: string,
  options: ShotOptions,
): Promise<ShotResult> {
  const { outDir, htmlshotPath, execFile, width, height } = options;
  const htmlPath = join(outDir, `${id}.html`);
  const pngPath = join(outDir, `${id}.html.png`);
  await writeFile(htmlPath, html, "utf8");

  const args = [
    "shot",
    htmlPath,
    "-o",
    pngPath,
    "--width",
    String(width),
    "--height",
    String(height),
  ];

  const outcome = await run(execFile, htmlshotPath, args);

  if (outcome.code !== 0) {
    await unlink(htmlPath).catch(() => {});
    return { ok: false, error: lastErrorLine(outcome.stderr || outcome.stdout) };
  }

  await unlink(htmlPath).catch(() => {});
  return { ok: true, pngPath };
}

function assistantText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

async function previewBlock(
  pi: Pick<ExtensionAPI, "sendMessage">,
  deps: ExtensionDeps,
  block: OpuiLangBlock,
  index: number,
): Promise<void> {
  const fail = (message: string) =>
    pi.sendMessage({
      customType: OPENUI_CUSTOM_TYPE,
      content: "openui preview failed",
      display: true,
      details: { kind: "error", message } satisfies PreviewDetails,
    });

  if (block.unclosed) {
    await fail(`openui-lang block at line ${block.startLine} has no closing fence`);
    return;
  }

  const rendered = renderOpuiLang(block.source, deps.generatedDir);
  if (!rendered.ok) {
    await fail(rendered.error);
    return;
  }

  const id = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await shotHtml(rendered.html, id, deps);

  await pi.sendMessage({
    customType: OPENUI_CUSTOM_TYPE,
    content: result.ok ? "openui preview" : "openui preview failed",
    display: true,
    details: result.ok
      ? { kind: "image", pngPath: result.pngPath } satisfies PreviewDetails
      : { kind: "error", message: result.error } satisfies PreviewDetails,
  });
}

interface PreviewTheme {
  bg: (color: string, text: string) => string;
  fg: (color: string, text: string) => string;
}

export function renderPreview(
  details: PreviewDetails | undefined,
  options: { outputPad: number },
  theme: PreviewTheme,
): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));

  if (!details || details.kind === "error") {
    const text = details?.message ?? "openui preview unavailable";
    box.addChild(new Text(theme.fg("error", `[openui] ${text}`), 0, 0));
    return box;
  }

  try {
    const png = readFileSync(details.pngPath ?? "");
    const image = new Image(
      png.toString("base64"),
      "image/png",
      { fallbackColor: (text: string) => theme.fg("dim", text) },
      { maxHeightCells: MAX_HEIGHT_CELLS, filename: basename(details.pngPath ?? "") },
    );
    box.addChild(image);
  } catch {
    box.addChild(
      new Text(theme.fg("dim", `[openui] preview file missing: ${details.pngPath}`), 0, 0),
    );
  }
  return box;
}

export default function openuiPreviewExtension(
  pi: ExtensionAPI,
  overrides?: Partial<Pick<ExtensionDeps, "outDir" | "htmlshotPath" | "execFile" | "enqueue" | "generatedDir">>,
): void {
  const home = process.env.HOME ?? "";
  const deps: ExtensionDeps = {
    outDir: join(home, ".agents", "work", "openui-preview"),
    htmlshotPath: join(home, ".agents", "cli", "htmlshot"),
    execFile: execFileCb,
    enqueue: createQueue(),
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    ...overrides,
  };

  pi.registerMessageRenderer<PreviewDetails>(OPENUI_CUSTOM_TYPE, (message, options, theme) =>
    renderPreview(message.details, options, {
      bg: (color, text) => theme.bg(color as ThemeBg, text),
      fg: (color, text) => theme.fg(color as ThemeColor, text),
    }),
  );

  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant" ? stripOpuiLangBlocks(markdown) : markdown,
  );

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections[PROMPT_SECTION_NAME] = opuiInstructions(deps.generatedDir);
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    const blocks = extractOpuiLangBlocks(assistantText(message.content));
    for (const [index, block] of blocks.entries()) {
      deps
        .enqueue(() =>
          mkdir(deps.outDir, { recursive: true }).then(() =>
            previewBlock(pi, deps, block, index),
          ),
        )
        .catch(() => {});
    }
  });
}
