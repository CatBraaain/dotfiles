import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  createCodemodeExtension,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  resetCapabilitiesCache,
  setCapabilities,
  stripTerminalSequences,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  type Terminal,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import toolRendererExtension, {
  formatCollapsedToolRow,
  renderersOf,
  type ToolRenderers,
} from "./index.ts";
import { installToolRowFolding } from "./tool-rows.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const fakeTui = { requestRender() {} } as unknown as TUI;
const toolNames = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "ask_permission",
  "codemode",
  "web_search",
  "web_fetch",
  "subagent",
  "recontext",
  "session_search",
  "create_detached_session",
  "powershell",
  "mystery_tool",
  "constructor",
];
const args = {
  command: "echo 日本語\necho second",
  path: "wide/日本語.txt",
  pattern: "match",
  content: "written\nlast written line",
  edits: [{ oldText: "before", newText: "after" }],
  query: "query",
  url: "https://example.test",
  agent: "junior",
  task: "child task",
  code: "text(1);",
  action: "search",
  initialRequest: "initial request",
};
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=";

function codemodeDefinition(): ToolRenderers {
  let definition: ToolRenderers | undefined;
  createCodemodeExtension()({
    registerTool(tool: ToolRenderers) {
      definition = tool;
    },
  } as unknown as ExtensionAPI);
  return definition!;
}

function createRow(
  name = "read",
  tui: TUI = fakeTui,
  next?: ToolRenderers,
): ToolExecutionComponent {
  return new ToolExecutionComponent(
    name,
    `${name}-id`,
    name === "codemode" ? { code: args.code } : args,
    {},
    renderersOf(name, () => next ?? (name === "codemode" ? codemodeDefinition() : undefined)),
    tui,
    "/project",
  );
}

function clickEvent(y = 0, width = 80, height = 1): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 0,
    y,
    screenX: 0,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function renderedText(row: ToolExecutionComponent): string {
  return row
    .render(120)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

function clickHeader(row: ToolExecutionComponent): void {
  const lines = row.render(80);
  const header = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
  row.handleMouse(clickEvent(header, 80, lines.length));
}

let dispose: () => void;
beforeEach(() => {
  initTheme("dark", false);
  dispose = installToolRowFolding((row) => formatCollapsedToolRow(row, plainTheme));
});
afterEach(() => {
  dispose();
  resetCapabilitiesCache();
});

describe("single tool rows", () => {
  for (const name of toolNames) {
    it(`keeps ${name} to one width-bounded row in every execution state`, () => {
      const row = createRow(name);
      const result = {
        content: [{ type: "text", text: "first output\n日本語😀\nlast output" }],
        details: { status: "granted" },
        isError: false,
        durationMs: 1200,
      };
      for (const state of ["arguments", "running", "partial", "success", "error"] as const) {
        if (state === "running") row.markExecutionStarted();
        if (state === "partial") row.updateResult(result, true);
        if (state === "success") row.updateResult(result);
        if (state === "error") row.updateResult({ ...result, isError: true });
        for (const width of [0, 1, 2, 10, 40, 120]) {
          const lines = row.render(width);
          const context = `${name}: ${state}, width=${width}`;
          assert.equal(lines.length, 1, context);
          assert.ok(visibleWidth(lines[0]!) <= width, context);
          assert.doesNotMatch(lines[0]!, /[\r\n\t]/, context);
        }
      }
    });
  }

  it("preserves summaries and uses the final core duration instead of wall-clock time", () => {
    const row = createRow("bash");
    row.updateResult({
      content: [{ type: "text", text: "output" }],
      isError: false,
      durationMs: 1200,
    });
    const first = renderedText(row);
    row.invalidate();
    assert.equal(renderedText(row), first);
    assert.match(first, /1\.2s/);
  });

  it("opens running tools before their first result and keeps streaming arguments current", () => {
    const row = createRow("bash");
    row.updateArgs({ command: "updated command" });
    assert.match(renderedText(row), /updated command/);
    clickHeader(row);
    assert.ok(row.render(80).length > 1);
    assert.match(renderedText(row), /updated command/);
    clickHeader(row);
    assert.equal(row.render(80).length, 1);
  });

  for (const entry of [
    { name: "read", expected: "last output" },
    { name: "write", expected: "last written line" },
    { name: "edit", expected: "+last diff line" },
    { name: "grep", expected: "last output" },
    { name: "find", expected: "last output" },
    { name: "ls", expected: "last output" },
    { name: "ask_permission", expected: "last output" },
    { name: "web_search", expected: "last output" },
    { name: "web_fetch", expected: "last output" },
    { name: "session_search", expected: "last output" },
    { name: "mystery_tool", expected: "last output" },
  ]) {
    it(`reveals the real ${entry.name} details on click and folds the same header again`, () => {
      const row = createRow(entry.name);
      row.updateResult({
        content: [{ type: "text", text: "first output\nlast output" }],
        details: { diff: "-before\n+last diff line", status: "granted", engine: "engine" },
        isError: false,
      });
      clickHeader(row);
      assert.ok(renderedText(row).includes(entry.expected));
      clickHeader(row);
      assert.equal(row.render(80).length, 1);
    });
  }

  it("shows every error line in the expanded details", () => {
    const row = createRow();
    row.updateResult({
      content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }],
      isError: true,
    });
    assert.equal(row.render(80).length, 1);
    clickHeader(row);
    assert.match(renderedText(row), /four\s+five/);
  });

  it("contains core-added images even with a self-rendering unknown tool", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const row = createRow("image_tool", fakeTui, {
      renderShell: "self",
      renderCall: () => new Text("image header", 0, 0),
      renderResult: () => new Text("image details", 0, 0),
    });
    row.updateResult({
      content: [{ type: "image", data: tinyPng, mimeType: "image/png" }],
      isError: false,
    });
    assert.equal(row.render(80).length, 1);
    assert.equal(row.render(80).join("").includes("\x1b_G"), false);
    clickHeader(row);
    assert.ok(row.render(80).join("").includes("\x1b_G"));
    clickHeader(row);
    assert.equal(row.render(80).length, 1);
    assert.equal(row.render(80).join("").includes("\x1b_G"), false);
  });

  it("retains expansion while partial and final results arrive", () => {
    const row = createRow("bash");
    clickHeader(row);
    row.updateResult(
      { content: [{ type: "text", text: "partial details" }], isError: false },
      true,
    );
    assert.match(renderedText(row), /partial details/);
    row.updateResult({ content: [{ type: "text", text: "final details" }], isError: false });
    row.invalidate();
    row.setOutputPad(3);
    assert.match(renderedText(row), /final details/);
    clickHeader(row);
    assert.equal(row.render(80).length, 1);
  });

  it("keeps an empty custom renderer reachable through its header", () => {
    const row = createRow("hidden_tool", fakeTui, {
      renderShell: "self",
      renderCall: () => new Container(),
      renderResult: () => new Container(),
    });
    clickHeader(row);
    assert.equal(row.render(80).length, 1);
    assert.match(renderedText(row), /hidden_tool/);
    clickHeader(row);
    assert.equal((row as unknown as { expanded: boolean }).expanded, false);
    assert.equal(row.render(80).length, 1);
  });

  for (const status of ["granted", "denied", "already granted"]) {
    it(`folds the ${status} permission result without altering it`, () => {
      const row = createRow("ask_permission");
      const result = Object.freeze({
        content: Object.freeze([{ type: "text", text: status }]),
        details: Object.freeze({ status }),
        isError: false,
      });
      row.updateResult(result as Parameters<ToolExecutionComponent["updateResult"]>[0]);
      assert.equal(row.render(80).length, 1);
      assert.ok(renderedText(row).includes(status));
      clickHeader(row);
      assert.ok(renderedText(row).includes(status));
      assert.equal(result.details.status, status);
    });
  }

  it("reveals recontext reason and handoff only after expansion", () => {
    const row = createRow("recontext");
    row.updateResult({
      content: [{ type: "text", text: "replacing context" }],
      details: { reason: "reason details", handoff: "handoff details" },
      isError: false,
    });
    assert.equal(row.render(80).length, 1);
    assert.doesNotMatch(renderedText(row), /handoff details/);
    clickHeader(row);
    assert.match(renderedText(row), /reason details/);
    assert.match(renderedText(row), /handoff details/);
    clickHeader(row);
    assert.equal(row.render(80).length, 1);
  });

  it("keeps codemode child calls and all text inside its expanded parent", () => {
    const row = createRow("codemode");
    const result = {
      content: [
        { type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
        { type: "text", text: "script output\nlast script output" },
      ],
      details: {
        calls: [
          {
            id: "script/1",
            name: "bash",
            args: "echo child",
            status: "error",
            durationMs: 100,
          },
        ],
      },
      isError: false,
    };
    const before = JSON.stringify(result);
    row.updateResult(result);
    assert.equal(row.render(80).length, 1);
    assert.match(renderedText(row), /failed calls/);
    clickHeader(row);
    assert.match(renderedText(row), /echo child/);
    assert.match(renderedText(row), /last script output/);
    assert.equal(JSON.stringify(result), before);
  });

  it("keeps subagent Task, Actions, Output and session details behind its row", () => {
    const row = createRow("subagent");
    row.updateResult({
      content: [{ type: "text", text: "child output" }],
      isError: false,
      details: {
        results: [
          {
            agent: "junior",
            task: "child task",
            pending: false,
            sessionId: "child-session",
            cwd: "/project",
            actions: [
              {
                name: "read",
                args: { path: "child.txt" },
                result: { content: [{ type: "text", text: "child file" }] },
              },
            ],
            messages: [
              { role: "assistant", content: [{ type: "text", text: "child final output" }] },
            ],
          },
        ],
      },
    });
    assert.equal(row.render(80).length, 1);
    clickHeader(row);
    const expanded = renderedText(row);
    for (const text of [
      "Task",
      "child task",
      "Actions",
      "read ./child.txt",
      "Output",
      "child final output",
      "child-session",
    ]) {
      assert.ok(expanded.includes(text), text);
    }
  });

  it("leaves non-click gestures, hidden children and core expansion notifications alone", () => {
    const row = createRow();
    const children = [...row.children];
    for (const change of [
      { type: "press" },
      { type: "drag" },
      { type: "wheel" },
      { button: "right" },
    ]) {
      assert.equal(row.handleMouse({ ...clickEvent(), ...change } as TuiMouseEvent), undefined);
      assert.equal(row.render(80).length, 1);
    }
    row.setExpanded(true);
    assert.ok(row.render(80).length > 1);
    row.setExpanded(false);
    assert.equal(row.render(80).length, 1);
    assert.deepEqual(row.children, children);
  });

  it("removes hooks on shutdown and installs exactly one layer on reload", () => {
    dispose();
    const originalRender = ToolExecutionComponent.prototype.render;
    const originalMouse = ToolExecutionComponent.prototype.handleMouse;
    const handlers = new Map<string, Function>();
    toolRendererExtension({
      registerToolRenderer() {},
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const context = { mode: "tui", ui: { theme: plainTheme } };
    handlers.get("session_start")!({}, context);
    handlers.get("session_start")!({}, context);
    const restored = createRow();
    assert.equal(restored.render(80).length, 1);
    handlers.get("session_shutdown")!({}, context);
    assert.equal(ToolExecutionComponent.prototype.render, originalRender);
    assert.equal(ToolExecutionComponent.prototype.handleMouse, originalMouse);
    assert.ok(restored.render(80).length > 1);
    handlers.get("session_start")!({}, { mode: "rpc" });
    assert.equal(ToolExecutionComponent.prototype.render, originalRender);
  });
});

describe("summary failure boundaries", () => {
  for (const phase of ["before validation", "after validation error"]) {
    it(`renders non-string session names ${phase}`, () => {
      const row = createRow("create_detached_session");
      row.updateArgs({ name: 42, initialRequest: "test" });
      if (phase === "after validation error") {
        row.updateResult({
          content: [{ type: "text", text: "argument validation failed" }],
          isError: true,
        });
      }
      const status = phase === "before validation" ? "Running..." : "argument validation failed";
      assert.equal(renderedText(row), `create_detached_session test — ${status}`);
    });
  }

  it("ignores a non-string initial request when formatting the session call", () => {
    const row = createRow("create_detached_session");
    row.updateArgs({ name: "  session label  ", initialRequest: 42 });
    assert.equal(renderedText(row), "create_detached_session session label — Running...");
    row.updateArgs({ name: 42, initialRequest: 42 });
    assert.ok(renderedText(row).startsWith("create_detached_session"));
    assert.equal(renderedText(row).includes("[render error]"), false);
  });

  for (const expanded of [false, true]) {
    it(`contains summary exceptions with a visible fallback when expanded=${expanded}`, () => {
      dispose();
      dispose = installToolRowFolding(() => {
        throw new Error("summary failed");
      });
      const row = createRow("mystery_tool", fakeTui, {
        renderShell: "self",
        renderCall: () => new Container(),
        renderResult: () => new Container(),
      });
      row.setExpanded(expanded);
      for (const width of [0, 1, 5, 80]) {
        const lines = row.render(width);
        assert.equal(lines.length, 1);
        assert.ok(visibleWidth(lines[0]!) <= width);
      }
      const parent = new Container();
      parent.addChild(row);
      parent.addChild(new Text("editor remains visible", 0, 0));
      assert.deepEqual(
        parent
          .render(80)
          .map(stripTerminalSequences)
          .map((line) => line.trimEnd()),
        ["mystery_tool — [render error]", "editor remains visible"],
      );
    });
  }

  for (const entry of [
    {
      title: "fetch details",
      name: "web_fetch",
      details: { error: "detailed failure" },
      cached: undefined,
      expected: 'web_fetch - "https://example.test" — ✗ web-fetch - "detailed failure"',
    },
    {
      title: "empty fetch details",
      name: "web_fetch",
      details: {},
      cached: undefined,
      expected: 'web_fetch - "https://example.test" — ✗ web-fetch - "backend failed"',
    },
    {
      title: "cached fetch details after an empty final update",
      name: "web_fetch",
      details: {},
      cached: { error: "cached failure" },
      expected: 'web_fetch - "https://example.test" — ✗ web-fetch - "cached failure"',
    },
    {
      title: "missing search details",
      name: "web_search",
      details: undefined,
      cached: undefined,
      expected: 'web_search - "query" — ✗ web-search - "backend failed"',
    },
  ]) {
    it(`retains the WEB failure format with ${entry.title}`, () => {
      const row = createRow(entry.name);
      if (entry.cached) {
        row.updateResult({ content: [], details: entry.cached, isError: true }, true);
      }
      row.updateResult({
        content: [{ type: "text", text: "backend failed" }],
        details: entry.details,
        isError: true,
      });
      assert.equal(renderedText(row), entry.expected);
      assert.equal(row.render(40).length, 1);
      assert.ok(visibleWidth(row.render(40)[0]!) <= 40);
    });
  }

  it("keeps ordinary non-WEB errors in the common summary format", () => {
    const row = createRow("read");
    row.updateResult({ content: [{ type: "text", text: "ordinary failure" }], isError: true });
    assert.equal(renderedText(row), "read ./wide/日本語.txt — ordinary failure");
  });
});

class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = true;
  input?: (data: string) => void;
  resize?: () => void;
  writes: string[] = [];
  start(input: (data: string) => void, resize: () => void) {
    this.input = input;
    this.resize = resize;
  }
  stop() {
    this.input = undefined;
  }
  async drainInput() {}
  write(text: string) {
    this.writes.push(text);
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

async function renderFrame(tui: TUI): Promise<void> {
  tui.requestRender(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function terminalClick(terminal: MemoryTerminal, row: number): void {
  terminal.input!(`\x1b[<0;1;${row + 1}M`);
  terminal.input!(`\x1b[<0;1;${row + 1}m`);
}

describe("headless fullscreen layout", () => {
  it("routes individual clicks after height changes without stealing approval input focus", async () => {
    const terminal = new MemoryTerminal();
    const tui = new TuiAltScreen(terminal, false, "/tmp/work/dotfiles", { copyOnSelect: false });
    const first = createRow("read", tui);
    const second = createRow("bash", tui);
    const editor = new Input({ prompt: "Approve? " });
    const chat = new Container();
    chat.addChild(first);
    chat.addChild(second);
    tui.addChild(chat);
    tui.addChild(editor);
    tui.setFocus(editor);
    first.updateResult({
      content: [{ type: "text", text: "file details\nlast file detail" }],
      isError: false,
    });
    second.updateResult({ content: [{ type: "text", text: "shell details" }], isError: false });
    tui.start();
    try {
      await renderFrame(tui);
      const firstY = tui
        .getScreenLines()
        .findIndex((line) => stripTerminalSequences(line).startsWith("read "));
      assert.ok(firstY >= 0);
      terminalClick(terminal, firstY);
      await renderFrame(tui);
      assert.match(renderedText(first), /last file detail/);
      assert.equal(second.render(80).length, 1);
      assert.equal(editor.focused, true);
      const secondY = tui
        .getScreenLines()
        .findIndex((line) => stripTerminalSequences(line).startsWith("$ "));
      assert.ok(secondY > firstY);
      terminalClick(terminal, secondY);
      await renderFrame(tui);
      assert.match(renderedText(second), /shell details/);
      assert.match(renderedText(first), /last file detail/);
      terminal.input!("y");
      assert.equal(editor.getValue(), "y");
      assert.equal(editor.focused, true);
      clickHeader(first);
      await renderFrame(tui);
      assert.equal(first.render(80).length, 1);
      assert.match(renderedText(second), /shell details/);
      terminal.columns = 24;
      terminal.resize!();
      await renderFrame(tui);
      assert.equal(first.render(24).length, 1);
      assert.ok(visibleWidth(first.render(24)[0]!) <= 24);
    } finally {
      tui.stop();
    }
  });

  it("keeps regular-mode mouse ownership and the existing expansion method across a mode change", async () => {
    const terminal = new MemoryTerminal();
    let active: TUI = new TuiAltScreen(terminal, false, "/tmp/work/dotfiles");
    const reference = new Proxy({} as TUI, {
      get(_target, property) {
        const value = Reflect.get(active, property);
        return typeof value === "function" ? value.bind(active) : value;
      },
    });
    const row = createRow("read", reference);
    active.addChild(row);
    active.start();
    await renderFrame(active);
    active.stop();
    active = new TuiMainScreen(terminal, false, "/tmp/work/dotfiles");
    active.addChild(row);
    active.start();
    try {
      await renderFrame(active);
      assert.equal(row.render(80).length, 1);
      assert.doesNotMatch(terminal.writes.at(-1) ?? "", /\?100[026]h/);
      row.setExpanded(true);
      await renderFrame(active);
      assert.ok(row.render(80).length > 1);
      row.setExpanded(false);
      await renderFrame(active);
      assert.equal(row.render(80).length, 1);
    } finally {
      active.stop();
    }
  });
});
