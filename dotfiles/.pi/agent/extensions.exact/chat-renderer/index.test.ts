import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentToolDetails } from "../agents/index.ts";
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
  "recontext",
  "session_search",
  "mainagent",
];

describe("chat-renderer registry", () => {
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

  for (const name of ["session_search", "mainagent"]) {
    it(`shows every text block when ${name} is expanded`, () => {
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
      const expected = "first\nsecond";
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

type SubagentAction = AgentToolDetails["results"][number]["actions"][number];
const childEndedAt = new Date(2026, 0, 2, 3, 4, 5).getTime();

function renderChildActions(actions: SubagentAction[], theme = plainTheme) {
  return renderersOf("subagent")!.renderResult!(
    {
      content: [],
      details: {
        results: [
          {
            agent: "worker",
            task: "work",
            cwd: "/child",
            pending: false,
            messages: [],
            actions,
          },
        ],
      },
    },
    collapsed,
    theme,
    {},
  );
}

describe("subagent action rows", () => {
  const successCases = [
    { name: "bash", args: { command: "bun test" }, summary: "$ bun test — 1.5s" },
    { name: "read", args: { path: "/child/a.ts" }, summary: "read ./a.ts — 2 lines" },
    { name: "write", args: { path: "a.ts", content: "abc" }, summary: "write ./a.ts — wrote 3B" },
    { name: "edit", args: { path: "a.ts" }, summary: "edit ./a.ts — edited 1 block(s)" },
    { name: "grep", args: { pattern: "match" }, summary: "grep match in . — 1 matches" },
    { name: "find", args: { pattern: "*.ts" }, summary: "find *.ts in . — 2 files" },
    { name: "ls", args: {}, summary: "ls . — 2 entries" },
    { name: "mystery", args: {}, summary: "mystery {} — a.ts:1: match other" },
  ];

  for (const entry of successCases) {
    it(`renders a completed ${entry.name} action as one timestamped row`, () => {
      const component = renderChildActions([
        {
          name: entry.name,
          args: entry.args,
          startedAt: childEndedAt - 1500,
          endedAt: childEndedAt,
          result: { content: [{ type: "text", text: "a.ts:1: match\nother" }] },
        },
      ]);
      const rows = component.render(100);
      assert.deepEqual(rows.slice(4, -1), [entry.summary.padEnd(92) + "03:04:05"]);
    });
  }

  for (const result of [{ content: [] }, {}, { content: [{ type: "image" }] }]) {
    it(`uses done for an unknown tool without text: ${JSON.stringify(result)}`, () => {
      const component = renderChildActions([{ name: "mystery", args: {}, result }]);
      assert.deepEqual(component.render(100).slice(4, -1), ["mystery {} — done"]);
    });
  }

  it("keeps action order and omits missing completion times", () => {
    const component = renderChildActions([
      { name: "bash", args: { command: "first" }, result: { content: [] } },
      { name: "bash", args: { command: "second" }, endedAt: childEndedAt },
    ]);
    assert.deepEqual(component.render(100).slice(4, -1), [
      "$ first — done",
      "$ second — Running...",
    ]);
  });

  it("uses the same saved completion time after restoring action details", () => {
    const saved = JSON.stringify([
      { name: "bash", args: { command: "true" }, endedAt: childEndedAt, result: { content: [] } },
    ]);
    const component = renderChildActions(JSON.parse(saved));
    assert.equal(component.render(80)[4], "$ true — done".padEnd(72) + "03:04:05");
    assert.equal(component.render(100)[4], "$ true — done".padEnd(92) + "03:04:05");
    assert.equal(component.render(80)[4], "$ true — done".padEnd(72) + "03:04:05");
  });

  for (const errorText of ["first\nsecond\tlast", ""]) {
    it(`renders a one-line error summary: ${JSON.stringify(errorText)}`, () => {
      const theme = {
        ...plainTheme,
        fg: (color: string, text: string) => (color === "error" ? `\x1b[31m${text}\x1b[39m` : text),
      };
      const component = renderChildActions(
        [
          {
            name: "bash",
            args: { command: "false" },
            isError: true,
            endedAt: childEndedAt,
            result: { content: [{ type: "text", text: errorText }] },
          },
        ],
        theme,
      );
      const actionRows = component.render(100).slice(4, -1);
      const summary = errorText === "" ? "Error" : "first second last";
      assert.equal(actionRows.length, 1);
      assert.equal(
        stripTerminalSequences(actionRows[0]!),
        `$ false — ${summary}`.padEnd(92) + "03:04:05",
      );
      assert.ok(actionRows[0]!.includes("\x1b[31m"));
    });
  }

  it("flattens multiline calls and unknown results before applying width limits", () => {
    const component = renderChildActions([
      { name: "bash", args: { command: "echo first\r\nsecond\tlast\u2028end" }, result: {} },
      {
        name: "mystery",
        args: {},
        result: {
          content: [
            { type: "text", text: "one\n二番" },
            { type: "text", text: "three\tlast" },
          ],
        },
      },
    ]);
    assert.deepEqual(component.render(100).slice(4, -1), [
      "$ echo first  second last end — done",
      "mystery {} — one 二番 three last",
    ]);
  });

  it("fits ANSI, wide characters and long arguments into one row on every resize", () => {
    const theme = {
      fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    };
    const component = renderChildActions(
      [
        {
          name: "read",
          args: { path: `/child/${"日本語😀".repeat(40)}` },
          endedAt: childEndedAt,
          result: { content: [{ type: "text", text: "data" }] },
        },
      ],
      theme,
    );
    for (const width of [120, 40, 10, 9, 8, 4, 1, 0, 80]) {
      const actionRows = (component as Container).children[4]!.render(width);
      assert.equal(actionRows.length, 1, `width: ${width}`);
      const row = actionRows[0]!;
      assert.equal(/[\r\n\t\u2028\u2029]/.test(row), false, `width: ${width}`);
      assert.ok(visibleWidth(row) <= width, `width: ${width}`);
      assert.equal(
        stripTerminalSequences(row).endsWith("03:04:05"),
        width >= 10,
        `width: ${width}`,
      );
    }
  });
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
