import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text, type Component } from "@earendil-works/pi-tui";
import { requestBackgroundBash, type BackgroundBashContext } from "../tools/background-bash.ts";
import { extractOpenuiLangBlocks, stripOpenuiLangBlocks, type OpenuiLangBlock } from "./fence";
import { validateOpenuiLang } from "./render";
import { shotOpenui, type ShotOptions } from "./snapshot";

const SKILL_PATH = fileURLToPath(new URL("./skills/openui-preview/SKILL.md", import.meta.url));

export const OPENUI_CUSTOM_TYPE = "openui-preview";
export const MAX_HEIGHT_CELLS = 30;

export interface PreviewDetails {
  kind: "image" | "error";
  pngPath?: string;
  message?: string;
}

type EnqueueFn = <T>(task: () => Promise<T>) => Promise<T>;
interface ExtensionDeps extends Omit<ShotOptions, "context"> {
  enqueue: EnqueueFn;
}

export function createQueue(): EnqueueFn {
  let chain: Promise<void> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

async function previewBlock(
  pi: Pick<ExtensionAPI, "appendEntry">,
  deps: ExtensionDeps,
  context: BackgroundBashContext & { signal?: AbortSignal },
  block: OpenuiLangBlock,
  index: number,
): Promise<void> {
  if (block.unclosed)
    throw new Error(`openui-lang block at line ${block.startLine} has no closing fence`);
  const validated = validateOpenuiLang(block.source, deps.generatedDir);
  if (!validated.ok) throw new Error(validated.error);
  const id = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const signal =
    context.signal && deps.signal
      ? AbortSignal.any([context.signal, deps.signal])
      : (context.signal ?? deps.signal);
  const result = await shotOpenui(block.source, id, { ...deps, context, signal });
  pi.appendEntry<PreviewDetails>(
    OPENUI_CUSTOM_TYPE,
    result.ok
      ? { kind: "image", pngPath: result.pngPath }
      : { kind: "error", message: result.error },
  );
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
    box.addChild(
      new Text(
        theme.fg("error", `[openui] ${details?.message ?? "openui preview unavailable"}`),
        0,
        0,
      ),
    );
    return box;
  }
  try {
    const png = readFileSync(details.pngPath ?? "");
    box.addChild(
      new Image(
        png.toString("base64"),
        "image/png",
        { fallbackColor: (text: string) => theme.fg("dim", text) },
        { maxHeightCells: MAX_HEIGHT_CELLS, filename: basename(details.pngPath ?? "") },
      ),
    );
  } catch {
    box.addChild(
      new Text(theme.fg("dim", `[openui] preview file missing: ${details.pngPath}`), 0, 0),
    );
  }
  return box;
}

export default function openuiPreviewExtension(
  pi: ExtensionAPI,
  overrides?: Partial<ExtensionDeps>,
): void {
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const deps: ExtensionDeps = {
    outDir: join(process.env.HOME ?? "", ".cache", "pi", "openui-preview"),
    requestBash: requestBackgroundBash,
    enqueue: createQueue(),
    signal: controller.signal,
    ...overrides,
  };
  pi.registerEntryRenderer<PreviewDetails>(OPENUI_CUSTOM_TYPE, (entry, _options, theme) =>
    renderPreview(
      entry.data,
      { outputPad: 0 },
      {
        bg: (color, text) => theme.bg(color as ThemeBg, text),
        fg: (color, text) => theme.fg(color as ThemeColor, text),
      },
    ),
  );
  pi.registerMessageRenderer<PreviewDetails>(OPENUI_CUSTOM_TYPE, (message, options, theme) =>
    renderPreview(message.details, options, {
      bg: (color, text) => theme.bg(color as ThemeBg, text),
      fg: (color, text) => theme.fg(color as ThemeColor, text),
    }),
  );
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "assistant" ? stripOpenuiLangBlocks(markdown) : markdown,
  );
  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PATH] }));
  pi.on("session_shutdown", async () => {
    controller.abort(new Error("OpenUI preview session stopped"));
    await Promise.allSettled(pending);
  });
  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    for (const [index, block] of extractOpenuiLangBlocks(text).entries()) {
      const task = deps
        .enqueue(async () => {
          if (controller.signal.aborted || deps.signal?.aborted) return;
          await previewBlock(pi, deps, ctx, block, index);
        })
        .catch((error) => {
          pi.appendEntry<PreviewDetails>(OPENUI_CUSTOM_TYPE, {
            kind: "error",
            message: `OpenUI block at line ${block.startLine}: ${String(error)}`,
          });
        });
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
    }
  });
}
