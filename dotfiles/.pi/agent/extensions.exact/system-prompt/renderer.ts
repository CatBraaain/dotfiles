// Collapsed indicator and scrollable TUI viewer for the effective system prompt.
//
// The indicator is a small gray widget above the editor, set once per session
// start (see index.ts): it summarizes the prompt (character and line counts)
// and hints at how to expand it. The full viewer opens only through
// intentional actions — the ctrl+shift+p shortcut, the /system-prompt
// command, or clicking the indicator. Clicks reach widgets only in fullscreen
// mode (regular mode leaves mouse input to the terminal), so the keyboard
// path is the primary trigger. Both are display-only — the prompt, tools, and
// transcript are never touched.
//
// The viewer reads the effective prompt through ctx.getSystemPrompt() at open
// time and renders it as a centered overlay the user can scroll and close.
// Scrolling is managed by the component itself instead of ScrollView: the
// overlay compositor renders components as line arrays without running the
// layout engine, so a ScrollView inside an overlay never receives viewport
// bounds and cannot scroll. Bounding the rendered lines here keeps the
// overlay self-contained in both regular and fullscreen modes, and gives
// the scroll behavior a direct test surface.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

/** Widget key for the collapsed prompt indicator shown above the editor. */
export const PROMPT_WIDGET_KEY = "system-prompt";
/** Keyboard shortcut that expands the indicator into the full viewer. */
export const PROMPT_VIEW_SHORTCUT = Key.ctrlShift("p");

/** Fraction of the terminal height the viewer overlay may occupy. */
export const VIEWER_MAX_HEIGHT_RATIO = 0.94;
/** Title + separator + bottom hint rows around the scrollable content. */
export const VIEWER_CHROME_ROWS = 3;
/** Smallest overlay height that still shows content. */
export const MIN_VIEWER_ROWS = 8;

/**
 * Overlay height budget for a terminal height. Matches the compositor's
 * percentage parsing of the overlay's `maxHeight: "94%"` option.
 */
export function viewerMaxRows(terminalRows: number): number {
  return Math.max(MIN_VIEWER_ROWS, Math.floor(terminalRows * VIEWER_MAX_HEIGHT_RATIO));
}

/** Styling surface the viewer needs; the real Theme satisfies this structurally. */
export interface ViewerTheme {
  fg: (token: "accent" | "dim", text: string) => string;
  bold: (text: string) => string;
}

export interface PromptViewerOptions {
  /** Full effective system prompt text to display. */
  promptText: string;
  /** Styling for the chrome lines. */
  theme: ViewerTheme;
  /** Total overlay height budget in terminal rows, read per render. */
  getMaxRows: () => number;
  /** Request a TUI re-render after scroll state changes. */
  requestRender: () => void;
  /** Close the viewer. */
  close: () => void;
}

const CLOSE_KEYS = ["escape", "enter", "q"] as const;

/** Count rendered text lines: an empty prompt is zero lines. */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** One-line summary of a prompt: total size in characters and lines. */
export function formatPromptSummary(promptText: string): string {
  return `system prompt: ${promptText.length} chars · ${countLines(promptText)} lines`;
}

export interface PromptIndicatorOptions {
  /** Effective system prompt summarized by the indicator. */
  promptText: string;
  /** Styling for the indicator line. */
  theme: ViewerTheme;
  /** Expand the indicator into the full viewer. */
  onActivate: () => void;
}

/** Build the collapsed prompt indicator widget component. */
export function createPromptIndicator(options: PromptIndicatorOptions): Component {
  const { promptText, theme, onActivate } = options;
  const line = `${formatPromptSummary(promptText)} · ${PROMPT_VIEW_SHORTCUT} or click to view`;
  return {
    render(width: number): string[] {
      return [truncateToWidth(theme.fg("dim", line), width)];
    },
    invalidate(): void {},
    handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
      if (event.button !== "left") return undefined;
      if (event.type !== "press" && event.type !== "click") return undefined;
      // Claim the press so fullscreen dispatch records this widget as the
      // press target and synthesizes a click on release; activating on the
      // press too would fire twice for one click. Activate on the click only.
      if (event.type === "click") onActivate();
      return { handled: true };
    },
  };
}

/**
 * Show the collapsed prompt indicator above the editor. No-op outside TUI
 * mode (RPC cannot forward component widgets; JSON and print have no UI)
 * and when the prompt is empty. Activating the indicator expands it into
 * the full viewer.
 */
export function setPromptIndicator(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const promptText = ctx.getSystemPrompt();
  if (promptText.length === 0) return;
  ctx.ui.setWidget(
    PROMPT_WIDGET_KEY,
    (_tui, theme) =>
      createPromptIndicator({
        promptText,
        theme,
        // Fire-and-forget: a failed display must not break the caller.
        onActivate: () => {
          void showSystemPromptViewer(ctx).catch(() => {});
        },
      }),
    { placement: "aboveEditor" },
  );
}

/** Build the scrollable system-prompt viewer component. */
export function createPromptViewer(options: PromptViewerOptions): Component {
  const { promptText, theme, getMaxRows, requestRender, close } = options;
  const content = new Text(promptText, 1, 0);
  let scrollTop = 0;
  let contentLineCount = 0;
  let viewportRows = 1;

  const scroll = (lines: number): void => {
    const maxScrollTop = Math.max(0, contentLineCount - viewportRows);
    const next = Math.min(Math.max(0, scrollTop + lines), maxScrollTop);
    if (next === scrollTop) return;
    scrollTop = next;
    requestRender();
  };

  return {
    render(width: number): string[] {
      const contentLines = content.render(width);
      contentLineCount = contentLines.length;
      viewportRows = Math.max(1, getMaxRows() - VIEWER_CHROME_ROWS);
      const maxScrollTop = Math.max(0, contentLineCount - viewportRows);
      scrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
      const visible = contentLines.slice(scrollTop, scrollTop + viewportRows);
      const range =
        maxScrollTop > 0
          ? ` [${scrollTop + 1}-${scrollTop + visible.length}/${contentLineCount}]`
          : "";
      const title = theme.fg("accent", theme.bold(`System prompt${range}`));
      const separator = theme.fg("dim", "─".repeat(width));
      const hint = theme.fg(
        "dim",
        "up/down scroll · pgup/pgdn page · home/end jump · esc/q/enter close",
      );
      return [
        truncateToWidth(title, width),
        truncateToWidth(separator, width),
        ...visible,
        truncateToWidth(hint, width),
      ];
    },
    invalidate(): void {
      content.invalidate();
    },
    handleInput(data: string): void {
      if (CLOSE_KEYS.some((key) => matchesKey(data, key))) {
        close();
        return;
      }
      if (matchesKey(data, "up")) scroll(-1);
      else if (matchesKey(data, "down")) scroll(1);
      else if (matchesKey(data, "pageUp")) scroll(-viewportRows);
      else if (matchesKey(data, "pageDown")) scroll(viewportRows);
      else if (matchesKey(data, "home")) scroll(-Number.MAX_SAFE_INTEGER);
      else if (matchesKey(data, "end")) scroll(Number.MAX_SAFE_INTEGER);
    },
    handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
      if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
      scroll(event.wheelDelta);
      return { handled: true };
    },
  };
}

/**
 * Show the effective system prompt in a scrollable overlay. No-op outside
 * TUI mode (RPC cannot forward custom components; JSON and print have no
 * UI) and when the prompt is empty. Resolves when the viewer is closed.
 */
export function showSystemPromptViewer(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") return Promise.resolve();
  const promptText = ctx.getSystemPrompt();
  if (promptText.length === 0) return Promise.resolve();
  return ctx.ui
    .custom<void>(
      (tui, theme, _keybindings, done) => {
        return createPromptViewer({
          promptText,
          theme,
          getMaxRows: () => viewerMaxRows(tui.terminal.rows),
          requestRender: () => tui.requestRender(),
          close: () => done(undefined),
        });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "94%", maxHeight: "94%" },
      },
    )
    .then(() => undefined);
}
