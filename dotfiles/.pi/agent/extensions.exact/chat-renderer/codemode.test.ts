import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  createCodemodeExtension,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import {
  codemodeRenderers,
  formatCollapsedToolRow,
  formatToolCall,
  type ToolRenderers,
} from "./index.ts";
import type { ToolRowState } from "./tool-rows.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function createCallHarness(formatCode?: (source: string) => Promise<string>) {
  const redraw = Promise.withResolvers<void>();
  const calls: Array<{ args: any; context: any }> = [];
  let invalidations = 0;
  const context = {
    argsComplete: true,
    expanded: true,
    state: {},
    invalidate() {
      invalidations++;
      redraw.resolve();
    },
  };
  const renderers = codemodeRenderers(
    () => ({
      renderCall(args, _theme, context) {
        calls.push({ args, context });
        return new Text(typeof args.code === "string" ? args.code : "[invalid arg]", 0, 0);
      },
      renderResult: () => new Text("result", 0, 0),
    }),
    formatCode,
  )!;
  return {
    context,
    calls,
    redraw: redraw.promise,
    get invalidations() {
      return invalidations;
    },
    render(args: any) {
      return renderers.renderCall!(args, plainTheme, { ...context, args });
    },
  };
}

function componentText(component: { render(width: number): string[] }): string {
  return component
    .render(120)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

describe("codemode call preview", () => {
  for (const newline of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    it(`shows only the original first line for ${JSON.stringify(newline)}`, () => {
      const code = `const value=1;${newline}text(value);`;
      assert.equal(
        formatToolCall("codemode", { code }, "/cwd", plainTheme),
        "codemode const value=1;",
      );
    });
  }

  it("keeps a blank first line instead of summarizing a later line", () => {
    assert.equal(
      formatToolCall("codemode", { code: "\ntext(1);" }, "/cwd", plainTheme),
      "codemode ",
    );
  });

  it("keeps the duration and failed-call status in the collapsed row", () => {
    const row: ToolRowState = {
      toolName: "codemode",
      toolCallId: "preview-test",
      expanded: false,
      outputPad: 0,
      rendererState: {},
      ui: { requestRender() {} } as unknown as TUI,
      args: { code: "text(1);\ntext(2);" },
      cwd: "/cwd",
      isPartial: false,
      result: {
        content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" }],
        details: { calls: [{ status: "error" }] },
        isError: false,
      },
    };
    assert.equal(
      formatCollapsedToolRow(row, plainTheme as Theme, 120),
      "codemode text(1); — 1.2s (failed calls)",
    );
  });
});

describe("codemode display formatting", () => {
  it("uses oxfmt on display copies and keeps standard renderer state", async () => {
    const harness = createCallHarness();
    const args = Object.freeze({ code: "const value={a:1};text(value);" });
    const before = JSON.stringify(args);
    assert.equal(componentText(harness.render(args)), args.code);
    await harness.redraw;
    assert.equal(componentText(harness.render(args)), "const value = { a: 1 };\ntext(value);\n");
    const display = harness.calls.at(-1)!;
    assert.equal(display.context.args, display.args);
    assert.equal(display.context.state, harness.context.state);
    assert.notEqual(display.args, args);
    assert.equal(JSON.stringify(args), before);
    harness.render(args);
    assert.equal(harness.invalidations, 1);
  });

  it("formats top-level await and return snippets", async () => {
    const harness = createCallHarness();
    const args = { code: "const result=await tools.ls({});return result;" };
    harness.render(args);
    await harness.redraw;
    assert.equal(
      componentText(harness.render(args)),
      "const result = await tools.ls({});\nreturn result;\n",
    );
  });

  it("keeps syntax errors unchanged when oxfmt reports errors", async () => {
    const harness = createCallHarness();
    const args = { code: "const value={" };
    harness.render(args);
    await harness.redraw;
    assert.equal(componentText(harness.render(args)), args.code);
    assert.equal(harness.invalidations, 1);
  });

  it("keeps original code after a rejected formatter without retrying", async () => {
    let attempts = 0;
    const harness = createCallHarness(async () => {
      attempts++;
      throw new Error("formatter unavailable");
    });
    const args = { code: "text( 1 )" };
    harness.render(args);
    await harness.redraw;
    assert.equal(componentText(harness.render(args)), args.code);
    harness.render(args);
    assert.equal(attempts, 1);
    assert.equal(harness.invalidations, 1);
  });

  for (const mode of ["collapsed", "incomplete"]) {
    it(`keeps ${mode} input unformatted`, () => {
      let attempts = 0;
      const harness = createCallHarness(async (source) => {
        attempts++;
        return source;
      });
      harness.context.expanded = mode !== "collapsed";
      harness.context.argsComplete = mode !== "incomplete";
      const args = { code: "text( 1 )" };
      assert.equal(componentText(harness.render(args)), args.code);
      assert.equal(attempts, 0);
    });
  }

  for (const code of [undefined, null, 42]) {
    it(`delegates invalid code ${String(code)} without formatting`, () => {
      let attempts = 0;
      const harness = createCallHarness(async (source) => {
        attempts++;
        return source;
      });
      assert.equal(componentText(harness.render({ code })), "[invalid arg]");
      assert.equal(attempts, 0);
    });
  }

  it("ignores older formatting results after input changes", async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const requested: string[] = [];
    const harness = createCallHarness((source) => {
      requested.push(source);
      return source === "text(1)" ? first.promise : second.promise;
    });
    harness.render({ code: "text(1)" });
    harness.render({ code: "text(1)" });
    harness.render({ code: "text(2)" });
    second.resolve("text(2);\n");
    await harness.redraw;
    first.resolve("text(1);\n");
    await first.promise;
    await Promise.resolve();
    assert.equal(componentText(harness.render({ code: "text(2)" })), "text(2);\n");
    assert.deepEqual(requested, ["text(1)", "text(2)"]);
    assert.equal(harness.invalidations, 1);
  });

  it("invalidates an in-flight request when the input becomes incomplete", async () => {
    const pending = Promise.withResolvers<string>();
    const harness = createCallHarness(() => pending.promise);
    const args = { code: "text(1)" };
    harness.render(args);
    harness.context.argsComplete = false;
    harness.render(args);
    pending.resolve("text(1);\n");
    await pending.promise;
    await Promise.resolve();
    assert.equal(componentText(harness.render(args)), args.code);
    assert.equal(harness.invalidations, 0);
  });

  it("preserves missing call renderers", () => {
    const wrapped = codemodeRenderers(() => ({ renderResult: () => new Text("result") }));
    assert.equal(wrapped?.renderCall, undefined);
  });

  it("redraws a real tool row with the standard syntax-highlighted call", async () => {
    initTheme("dark", false);
    let inner: ToolRenderers | undefined;
    createCodemodeExtension()({
      registerTool(tool: ToolRenderers) {
        inner = tool;
      },
    } as unknown as ExtensionAPI);
    const redraw = Promise.withResolvers<void>();
    const standardSources: string[] = [];
    const standardRenderCall = inner!.renderCall!;
    const delegated: ToolRenderers = {
      ...inner,
      renderCall(args, theme, context) {
        standardSources.push(args.code);
        return standardRenderCall(args, theme, context);
      },
    };
    const args = Object.freeze({ code: "const value={a:1};text(value);" });
    const formattedCode = "const value = { a: 1 };\ntext(value);\n";
    const result = Object.freeze({ content: [{ type: "text", text: "output" }], isError: false });
    const row = new ToolExecutionComponent(
      "codemode",
      "format-test",
      args,
      {},
      codemodeRenderers(() => delegated),
      {
        requestRender() {
          if (standardSources.at(-1) === formattedCode) redraw.resolve();
        },
      } as unknown as TUI,
      "/cwd",
    );
    row.setExpanded(true);
    row.setArgsComplete();
    const before = JSON.stringify({ args, result });
    row.updateResult(result);
    await redraw.promise;
    const lines = row.render(120);
    assert.ok(lines.some((line) => line.includes("\u001b[")));
    assert.match(componentText(row), /const value = \{ a: 1 \};\n/);
    assert.equal(standardSources.at(-1), formattedCode);
    assert.equal(JSON.stringify({ args, result }), before);
  });
});
