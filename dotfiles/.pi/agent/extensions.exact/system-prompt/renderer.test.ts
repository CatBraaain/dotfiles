// Tests for the collapsed prompt indicator and the on-demand system-prompt
// viewer. The component logic is tested directly with injected terminal
// sizes and the real key parser (matchesKey from @earendil-works/pi-tui);
// setPromptIndicator and showSystemPromptViewer are tested through a mock
// extension context that records the widget and custom UI requests.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Text,
  matchesKey,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  PROMPT_VIEW_SHORTCUT,
  PROMPT_WIDGET_KEY,
  VIEWER_CHROME_ROWS,
  createPromptIndicator,
  createPromptViewer,
  formatPromptSummary,
  setPromptIndicator,
  showSystemPromptViewer,
  viewerMaxRows,
  type ViewerTheme,
} from "./renderer.ts";

type ExtensionMode = "tui" | "rpc" | "json" | "print";

const plainTheme: ViewerTheme = { fg: (_token, text) => text, bold: (text) => text };

/** Real terminal sequences for the keys the viewer handles. */
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  escape: "\x1b",
  enter: "\r",
} as const;

const WIDTH = 80;

/** A prompt that wraps to `lineCount` rendered lines at WIDTH columns. */
function promptOfLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_value, index) => `line ${index + 1}`).join("\n");
}

/** The lines the viewer's content component produces for a prompt. */
function wrappedContent(prompt: string, width = WIDTH): string[] {
  return new Text(prompt, 1, 0).render(width);
}

function viewerFor(
  prompt: string,
  terminalRows: number,
): {
  component: Component;
  requestRenderCount: () => number;
} {
  let requestRenders = 0;
  const component = createPromptViewer({
    promptText: prompt,
    theme: plainTheme,
    getMaxRows: () => viewerMaxRows(terminalRows),
    requestRender: () => {
      requestRenders += 1;
    },
    close: () => {},
  });
  return { component, requestRenderCount: () => requestRenders };
}

interface CustomCall {
  factory: (tui: TUI, theme: never, keybindings: never, done: (result: void) => void) => Component;
  options: { overlay?: boolean; overlayOptions?: unknown } | undefined;
}

/** Extension context mock that records ctx.ui.custom requests. */
function mockViewerCtx(
  mode: ExtensionMode,
  prompt: string,
): { ctx: ExtensionContext; customCalls: CustomCall[] } {
  const customCalls: CustomCall[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    getSystemPrompt: () => prompt,
    ui: {
      custom: (factory: CustomCall["factory"], options?: CustomCall["options"]) => {
        customCalls.push({ factory, options });
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, customCalls };
}

/** Minimal TUI surface the viewer factory reads. */
function fakeTui(rows: number): TUI {
  return {
    terminal: { rows, columns: WIDTH },
    requestRender: () => {},
  } as unknown as TUI;
}

function componentFromCall(call: CustomCall, rows: number): Component {
  return call.factory(fakeTui(rows), plainTheme as never, undefined as never, () => {});
}

/** A minimal mouse event for the indicator's activation surface. */
function mouseEvent(
  type: TuiMouseEvent["type"],
  button: TuiMouseEvent["button"],
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button,
    x: 1,
    y: 0,
    screenX: 1,
    screenY: 0,
    width: WIDTH,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
    ...(wheelDelta === undefined ? {} : { wheelDelta }),
  };
}

describe("formatPromptSummary", () => {
  it("summarizes the prompt size in characters and lines", () => {
    const prompt = "You are an expert.\n\n<tools>\n- bash\n</tools>";
    assert.equal(formatPromptSummary(prompt), `system prompt: ${prompt.length} chars · 5 lines`);
  });

  it("counts a single line without newlines as one line", () => {
    assert.equal(formatPromptSummary("abc"), "system prompt: 3 chars · 1 lines");
  });
});

describe("createPromptIndicator", () => {
  it("renders one dim line with the summary and the expand hint", () => {
    const prompt = "line one\nline two";
    let activations = 0;
    const component = createPromptIndicator({
      promptText: prompt,
      theme: plainTheme,
      onActivate: () => {
        activations += 1;
      },
    });
    const rendered = component.render(WIDTH);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0], `${formatPromptSummary(prompt)} · ctrl+shift+p or click to view`);
    assert.equal(activations, 0);
  });

  it("truncates the line to the widget width", () => {
    const component = createPromptIndicator({
      promptText: promptOfLines(50),
      theme: plainTheme,
      onActivate: () => {},
    });
    for (const width of [10, 30, WIDTH]) {
      const [line] = component.render(width);
      assert.ok(line !== undefined);
      assert.ok(visibleWidth(line) <= width);
    }
  });

  it("activates exactly once per click sequence and not on press alone", () => {
    let activations = 0;
    const component = createPromptIndicator({
      promptText: "prompt",
      theme: plainTheme,
      onActivate: () => {
        activations += 1;
      },
    });
    // Fullscreen dispatch delivers press (claimed, no activation), then
    // release, then a synthesized click to the press target.
    assert.deepEqual(component.handleMouse?.(mouseEvent("press", "left")), { handled: true });
    assert.equal(component.handleMouse?.(mouseEvent("release", "left")), undefined);
    assert.deepEqual(component.handleMouse?.(mouseEvent("click", "left")), { handled: true });
    assert.equal(activations, 1);
  });

  it("ignores other mouse buttons and non-activating events", () => {
    let activations = 0;
    const component = createPromptIndicator({
      promptText: "prompt",
      theme: plainTheme,
      onActivate: () => {
        activations += 1;
      },
    });
    assert.equal(component.handleMouse?.(mouseEvent("press", "right")), undefined);
    assert.equal(component.handleMouse?.(mouseEvent("click", "right")), undefined);
    assert.equal(component.handleMouse?.(mouseEvent("release", "left")), undefined);
    assert.equal(component.handleMouse?.(mouseEvent("wheel", "none", 2)), undefined);
    assert.equal(component.handleMouse?.(mouseEvent("move", "none")), undefined);
    assert.equal(activations, 0);
  });
});

describe("PROMPT_VIEW_SHORTCUT", () => {
  it("is ctrl+shift+p and matches real terminal sequences", () => {
    assert.equal(PROMPT_VIEW_SHORTCUT, "ctrl+shift+p");
    // Kitty protocol encodings of ctrl+shift+p (uppercase and lowercase P).
    assert.equal(matchesKey("\x1b[80;6u", PROMPT_VIEW_SHORTCUT), true);
    assert.equal(matchesKey("\x1b[112;6u", PROMPT_VIEW_SHORTCUT), true);
    assert.equal(matchesKey("\x1b[113;6u", PROMPT_VIEW_SHORTCUT), false);
    assert.equal(matchesKey("p", PROMPT_VIEW_SHORTCUT), false);
  });
});

describe("createPromptViewer", () => {
  it("renders the whole prompt between the chrome when it fits", () => {
    const prompt = promptOfLines(5);
    const { component } = viewerFor(prompt, 40);
    const rendered = component.render(WIDTH);
    assert.equal(rendered.length, VIEWER_CHROME_ROWS + wrappedContent(prompt).length);
    assert.match(rendered[0]!, /^System prompt$/);
    assert.deepEqual(rendered.slice(2, -1), wrappedContent(prompt));
    assert.match(rendered.at(-1)!, /esc\/q\/enter close/);
  });

  it("bounds the rendered lines to the terminal height budget", () => {
    const prompt = promptOfLines(300);
    const rows = 30;
    const { component } = viewerFor(prompt, rows);
    const rendered = component.render(WIDTH);
    assert.equal(rendered.length, viewerMaxRows(rows));
    for (const line of rendered) {
      assert.ok(visibleWidth(line) <= WIDTH);
    }
    // The visible window is the first viewport slice of the wrapped prompt.
    assert.deepEqual(
      rendered.slice(2, -1),
      wrappedContent(prompt).slice(0, viewerMaxRows(rows) - VIEWER_CHROME_ROWS),
    );
    assert.match(rendered[0]!, /\[1-\d+\/300\]/);
  });

  it("scrolls by line and by page and reports the position", () => {
    const prompt = promptOfLines(100);
    const { component } = viewerFor(prompt, 24); // budget 22, viewport 19
    const viewportRows = viewerMaxRows(24) - VIEWER_CHROME_ROWS;
    const content = wrappedContent(prompt);

    component.render(WIDTH);
    component.handleInput?.(KEYS.down);
    assert.match(component.render(WIDTH)[0]!, /\[2-\d+\/100\]/);

    component.handleInput?.(KEYS.pagedown);
    const rendered = component.render(WIDTH);
    assert.deepEqual(rendered.slice(2, -1), content.slice(1 + viewportRows, 1 + 2 * viewportRows));

    component.handleInput?.(KEYS.end);
    const atEnd = component.render(WIDTH);
    assert.deepEqual(atEnd.slice(2, -1), content.slice(100 - viewportRows));

    component.handleInput?.(KEYS.home);
    assert.deepEqual(component.render(WIDTH).slice(2, -1), content.slice(0, viewportRows));
  });

  it("clamps scrolling at both ends without requesting renders", () => {
    const prompt = promptOfLines(100);
    const { component, requestRenderCount } = viewerFor(prompt, 40); // viewport 34 < 100 lines
    component.render(WIDTH);
    const before = requestRenderCount();
    component.handleInput?.(KEYS.up);
    assert.equal(requestRenderCount(), before);
    component.handleInput?.(KEYS.pageup);
    assert.equal(requestRenderCount(), before);

    component.handleInput?.(KEYS.end);
    assert.equal(requestRenderCount(), before + 1);
    component.handleInput?.(KEYS.down);
    component.handleInput?.(KEYS.pagedown);
    assert.equal(requestRenderCount(), before + 1);
  });

  it("closes on escape, enter, and q but not on scroll keys", () => {
    for (const key of [KEYS.escape, KEYS.enter, "q"]) {
      let closed = 0;
      const component = createPromptViewer({
        promptText: promptOfLines(50),
        theme: plainTheme,
        getMaxRows: () => viewerMaxRows(24),
        requestRender: () => {},
        close: () => {
          closed += 1;
        },
      });
      component.render(WIDTH);
      component.handleInput?.(KEYS.down);
      assert.equal(closed, 0);
      component.handleInput?.(key);
      assert.equal(closed, 1);
    }
  });

  it("wraps long lines so every rendered line fits the width", () => {
    const longToken = "x".repeat(300);
    const prompt = `short line\n${longToken}\nanother line`;
    const { component } = viewerFor(prompt, 40);
    const rendered = component.render(WIDTH);
    assert.ok(rendered.length > VIEWER_CHROME_ROWS);
    for (const line of rendered) {
      assert.ok(visibleWidth(line) <= WIDTH);
    }
  });

  it("scrolls with mouse wheel events and ignores other mouse types", () => {
    const prompt = promptOfLines(100);
    const { component } = viewerFor(prompt, 24);
    const viewportRows = viewerMaxRows(24) - VIEWER_CHROME_ROWS;
    const content = wrappedContent(prompt);
    component.render(WIDTH);

    const wheel = (delta: number) =>
      component.handleMouse?.({
        type: "wheel",
        button: "none",
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        width: WIDTH,
        height: viewportRows,
        shift: false,
        alt: false,
        ctrl: false,
        wheelDelta: delta,
      });
    assert.deepEqual(wheel(2), { handled: true });
    assert.deepEqual(component.render(WIDTH).slice(2, -1), content.slice(2, 2 + viewportRows));
    assert.deepEqual(wheel(-1), { handled: true });
    assert.deepEqual(component.render(WIDTH).slice(2, -1), content.slice(1, 1 + viewportRows));
    const press = component.handleMouse?.({
      type: "press",
      button: "left",
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: WIDTH,
      height: viewportRows,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.equal(press, undefined);
  });
});

describe("showSystemPromptViewer", () => {
  it("passes the effective prompt verbatim into an overlay in tui mode", async () => {
    const prompt = [
      "You are an expert coding assistant.",
      "<tools>",
      ...Array.from(
        { length: 60 },
        (_value, index) => `- tool${index + 1}: does thing ${index + 1}`,
      ),
      "</tools>",
    ].join("\n");
    const { ctx, customCalls } = mockViewerCtx("tui", prompt);

    await showSystemPromptViewer(ctx);
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options?.overlay, true);
    assert.deepEqual(customCalls[0]!.options?.overlayOptions, {
      anchor: "center",
      width: "94%",
      maxHeight: "94%",
    });

    const component = componentFromCall(customCalls[0]!, 200);
    const rendered = component.render(WIDTH);
    // A tall enough terminal shows the whole wrapped prompt verbatim.
    assert.deepEqual(rendered.slice(2, -1), wrappedContent(prompt));
    assert.equal(rendered[0], "System prompt");
  });

  it("does nothing outside tui mode", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const { ctx, customCalls } = mockViewerCtx(mode, "prompt");
      await showSystemPromptViewer(ctx);
      assert.equal(customCalls.length, 0);
    }
  });

  it("does nothing for an empty prompt in tui mode", async () => {
    const { ctx, customCalls } = mockViewerCtx("tui", "");
    await showSystemPromptViewer(ctx);
    assert.equal(customCalls.length, 0);
  });
});

describe("setPromptIndicator", () => {
  /** Extension context mock that records setWidget and ui.custom requests. */
  function mockIndicatorCtx(
    mode: ExtensionMode,
    getPrompt: () => string,
  ): { ctx: ExtensionContext; widgetCalls: WidgetCall[]; customCalls: CustomCall[] } {
    const widgetCalls: WidgetCall[] = [];
    const customCalls: CustomCall[] = [];
    const ctx = {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      getSystemPrompt: getPrompt,
      ui: {
        setWidget: (
          key: string,
          content: ((tui: TUI, theme: ViewerTheme) => Component) | string[] | undefined,
          options?: { placement?: string },
        ) => {
          widgetCalls.push({ key, content, options });
        },
        custom: (factory: CustomCall["factory"], options?: CustomCall["options"]) => {
          customCalls.push({ factory, options });
          return Promise.resolve(undefined);
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, widgetCalls, customCalls };
  }

  interface WidgetCall {
    key: string;
    content: ((tui: TUI, theme: ViewerTheme) => Component) | string[] | undefined;
    options: { placement?: string } | undefined;
  }

  function indicatorComponent(call: WidgetCall): Component {
    if (typeof call.content !== "function") throw new Error("widget content must be a factory");
    return call.content(fakeTui(40), plainTheme);
  }

  it("sets a one-line aboveEditor widget summarizing the prompt in tui mode", () => {
    const prompt = "effective prompt\nwith two lines";
    const { ctx, widgetCalls, customCalls } = mockIndicatorCtx("tui", () => prompt);

    setPromptIndicator(ctx);
    assert.equal(customCalls.length, 0);
    assert.equal(widgetCalls.length, 1);
    assert.equal(widgetCalls[0]!.key, PROMPT_WIDGET_KEY);
    assert.equal(widgetCalls[0]!.options?.placement, "aboveEditor");

    const rendered = indicatorComponent(widgetCalls[0]!).render(WIDTH);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0], `${formatPromptSummary(prompt)} · ctrl+shift+p or click to view`);
    // The collapsed indicator never carries the prompt itself.
    assert.equal(rendered[0]!.includes("effective prompt"), false);
  });

  it("expands into the overlay viewer exactly once per click sequence", () => {
    const prompt = promptOfLines(30);
    const { ctx, widgetCalls, customCalls } = mockIndicatorCtx("tui", () => prompt);
    setPromptIndicator(ctx);

    const indicator = indicatorComponent(widgetCalls[0]!);
    indicator.handleMouse?.(mouseEvent("press", "left"));
    assert.equal(customCalls.length, 0);
    indicator.handleMouse?.(mouseEvent("release", "left"));
    indicator.handleMouse?.(mouseEvent("click", "left"));
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options?.overlay, true);

    const rendered = componentFromCall(customCalls[0]!, 200).render(WIDTH);
    assert.deepEqual(rendered.slice(2, -1), wrappedContent(prompt));
  });

  it("reads the prompt at open time, not at indicator time", () => {
    let current = "first prompt";
    const { ctx, widgetCalls, customCalls } = mockIndicatorCtx("tui", () => current);
    setPromptIndicator(ctx);
    assert.match(indicatorComponent(widgetCalls[0]!).render(WIDTH)[0]!, /12 chars/);

    current = "second, much longer prompt\nthat changed after the indicator was set";
    indicatorComponent(widgetCalls[0]!).handleMouse?.(mouseEvent("click", "left"));
    assert.equal(customCalls.length, 1);
    const rendered = componentFromCall(customCalls[0]!, 200).render(WIDTH);
    assert.deepEqual(rendered.slice(2, -1), wrappedContent(current));
  });

  it("does nothing outside tui mode", () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const { ctx, widgetCalls } = mockIndicatorCtx(mode, () => "prompt");
      setPromptIndicator(ctx);
      assert.equal(widgetCalls.length, 0);
    }
  });

  it("does nothing for an empty prompt in tui mode", () => {
    const { ctx, widgetCalls } = mockIndicatorCtx("tui", () => "");
    setPromptIndicator(ctx);
    assert.equal(widgetCalls.length, 0);
  });
});
