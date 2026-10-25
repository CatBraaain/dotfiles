import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import toolRendererExtension, { renderersOf, type ToolRenderers } from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const collapsed = { expanded: false, isPartial: false };

const KNOWN_TOOLS = [
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
  "replace_context",
  "session_search",
  "create_detached_session",
];

describe("tool-renderer registry", () => {
  it("returns renderers for every known tool", () => {
    function stubNext() {
      return { renderResult: () => new Text("", 0, 0) };
    }
    for (const toolName of KNOWN_TOOLS) {
      const renderers = renderersOf(toolName, stubNext);
      assert.notEqual(renderers, undefined, toolName);
      assert.notEqual(renderers!.renderResult, undefined, `${toolName} renderResult`);
      if (toolName !== "codemode") {
        assert.notEqual(renderers!.renderCall, undefined, `${toolName} renderCall`);
      }
    }
  });

  it("falls through to next() for unknown tools", () => {
    const fallback: ToolRenderers = { renderCall: () => new Text("fallback", 0, 0) };
    assert.equal(
      renderersOf("mystery_tool", () => fallback),
      fallback,
    );
    assert.equal(
      renderersOf("mystery_tool", () => undefined),
      undefined,
    );
  });

  for (const toolName of ["toString", "constructor", "__proto__"]) {
    it(`falls through to next() for the inherited property name ${toolName}`, () => {
      const fallback: ToolRenderers = { renderCall: () => new Text("fallback", 0, 0) };
      assert.equal(
        renderersOf(toolName, () => fallback),
        fallback,
      );
    });
  }

  it("wraps the registered codemode renderers and passes renderCall through", () => {
    function innerRenderResult() {
      return new Text("inner", 0, 0);
    }
    const inner: ToolRenderers = { renderResult: innerRenderResult };
    const wrapped = renderersOf("codemode", () => inner)!;
    assert.notEqual(wrapped.renderResult, undefined);
    assert.notEqual(wrapped.renderResult, innerRenderResult);
  });

  it("returns the inner codemode renderers unchanged when they lack renderResult", () => {
    const inner: ToolRenderers = { renderCall: () => new Text("call", 0, 0) };
    assert.equal(
      renderersOf("codemode", () => inner),
      inner,
    );
    assert.equal(
      renderersOf("codemode", () => undefined),
      undefined,
    );
  });
});

describe("shared text renderers", () => {
  const cases = [
    { name: "read", args: { path: "a.ts" }, call: "read ./a.ts", summary: "2 lines" },
    {
      name: "write",
      args: { path: "a.ts", content: "abc" },
      call: "write ./a.ts",
      summary: "wrote 3B",
    },
    {
      name: "edit",
      args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
      call: "edit ./a.ts",
      summary: "edited 1 block(s)",
    },
    { name: "grep", args: { pattern: "match" }, call: "grep match in .", summary: "1 matches" },
    { name: "find", args: { pattern: "*.ts" }, call: "find *.ts in .", summary: "2 files" },
    { name: "ls", args: {}, call: "ls .", summary: "2 entries" },
    {
      name: "ask_permission",
      args: { path: "a.ts" },
      call: "ask_permission ./a.ts",
      summary: "granted",
    },
  ];

  for (const entry of cases) {
    it(`renders the ${entry.name} call and success summary`, () => {
      const renderers = renderersOf(entry.name)!;
      const context = { cwd: "/project", args: entry.args, state: {}, isError: false };
      const result = {
        content: [{ type: "text", text: "a.ts:1: match\nother" }],
        details: { status: "granted" },
      };
      assert.equal(
        renderers.renderCall!(entry.args, plainTheme, context)
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        entry.call,
      );
      assert.equal(
        renderers.renderResult!(result, collapsed, plainTheme, context)
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        entry.summary,
      );
    });

    it(`renders common progress for ${entry.name}`, () => {
      const result = { content: [{ type: "text", text: "uncommitted output" }] };
      const component = renderersOf(entry.name)!.renderResult!(
        result,
        { ...collapsed, isPartial: true },
        plainTheme,
        { isError: false },
      );
      assert.equal(
        component
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        "Running...",
      );
    });

    it(`renders the same three-line error preview for ${entry.name}`, () => {
      const result = { content: [{ type: "text", text: "one\r\ntwo\r\nthree\r\nfour\r\n" }] };
      const component = renderersOf(entry.name)!.renderResult!(result, collapsed, plainTheme, {
        isError: true,
      });
      assert.equal(
        component
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        "one\ntwo\nthree\n…",
      );
    });
  }

  it("keeps bash progress and elapsed time distinct from ordinary text results", () => {
    const renderers = renderersOf("bash")!;
    const context = { state: { startedAt: 1000, endedAt: 2250 }, isError: false };
    const result = { content: [{ type: "text", text: "latest stderr line" }] };
    const partial = renderers.renderResult!(
      result,
      { ...collapsed, isPartial: true },
      plainTheme,
      context,
    );
    const complete = renderers.renderResult!(result, collapsed, plainTheme, context);
    assert.equal(
      partial
        .render(120)
        .map((line) => line.trimEnd())
        .join("\n"),
      "latest stderr line",
    );
    assert.equal(
      complete
        .render(120)
        .map((line) => line.trimEnd())
        .join("\n"),
      "1.3s",
    );
  });

  for (const name of ["session_search", "create_detached_session"]) {
    it(`keeps the expanded text policy for ${name}`, () => {
      const result = {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      };
      const component = renderersOf(name)!.renderResult!(
        result,
        { ...collapsed, expanded: true },
        plainTheme,
        { isError: false },
      );
      const expected = name === "session_search" ? "first\nsecond" : "first";
      assert.equal(
        component
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        expected,
      );
    });

    it(`keeps status and error color for ${name}`, () => {
      const theme = { ...plainTheme, fg: (color: string, text: string) => `[${color}]${text}` };
      const result = { content: [], structuredContent: { status: "denied" } };
      const component = renderersOf(name)!.renderResult!(result, collapsed, theme, {
        isError: true,
      });
      assert.equal(
        component
          .render(120)
          .map((line) => line.trimEnd())
          .join("\n"),
        `[error]${name}: denied`,
      );
    });
  }
});

describe("renderer registration", () => {
  it("registers one resolver without registering any tool", () => {
    const resolvers: unknown[] = [];
    toolRendererExtension({
      registerToolRenderer: (resolver: unknown) => resolvers.push(resolver),
    } as unknown as ExtensionAPI);
    assert.equal(resolvers.length, 1);
  });

  it("loads without changing tools when the resolver API is unavailable", () => {
    assert.doesNotThrow(() => toolRendererExtension({} as ExtensionAPI));
  });
});
