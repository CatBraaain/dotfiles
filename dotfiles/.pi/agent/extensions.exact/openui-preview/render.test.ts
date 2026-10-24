import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it } from "bun:test";
import { SUPPORTED_COMPONENTS, inlineMarkdown, renderOpuiLang } from "./render";

let specDir: string;

beforeAll(async () => {
  specDir = mkdtempSync(join(tmpdir(), "openui-render-test-"));
  const agentDir = join(import.meta.dir, "..", "..");
  const libraryPath = join(import.meta.dir, "library.data.ts");
  assert.ok(existsSync(libraryPath), "library.data.ts should exist");
  const generated = Bun.spawnSync(
    [
      process.execPath,
      cliEntry(agentDir),
      "generate",
      libraryPath,
      "--spec",
      "--out",
      join(specDir, "spec.json"),
      "--no-telemetry",
    ],
    { cwd: agentDir },
  );
  if (generated.exitCode !== 0) {
    throw new Error(`openui generate failed: ${generated.stderr.toString()}`);
  }
  assert.ok(existsSync(join(specDir, "spec.json")), "spec.json should be generated");
}, 30_000);

function render(source: string) {
  return renderOpuiLang(source, specDir);
}

describe("renderOpuiLang", () => {
  it("renders a program with every supported component into one document", () => {
    const source = [
      "root = Stack([header, sep, card, callout, tcallout, tags])",
      'header = InlineHeader("Deploy Summary", "2026-06-24 build")',
      "sep = Separator()",
      'card = Card([body, list, table], "sunk")',
      'body = TextContent("Build **passed** with 0 warnings", "small")',
      'list = ListBlock([i1, i2], "number")',
      'i1 = ListItem("Unit tests", "42 passed")',
      'i2 = ListItem("Type check")',
      "table = Table([nameCol, scoreCol])",
      'nameCol = Col("Name", ["a", "b"])',
      'scoreCol = Col("Score", [1, 2])',
      'callout = Callout("info", "Note", "Deployed to *staging*")',
      'tcallout = TextCallout("success", "Done", "All checks green")',
      'tags = TagBlock(["prod", "ok"], "sm")',
    ].join("\n");

    const result = render(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const className of [
      "opui-stack",
      "opui-inline-header",
      "opui-separator",
      "opui-card--sunk",
      "opui-text-content--small",
      "opui-list-block",
      "opui-list-item",
      "opui-table",
      "opui-callout--info",
      "opui-text-callout--success",
      "opui-tag--sm",
    ]) {
      assert.ok(result.html.includes(className), `missing ${className}`);
    }
    assert.ok(result.html.startsWith("<!doctype html>"));
    assert.ok(result.html.includes("<style>"));
    assert.ok(!result.html.includes("<script"));
  });

  it("renders Text and BoldText with subtext and metric tone", () => {
    const source = [
      "root = Stack([t, b])",
      't = Text("text", "Revenue", "month to date")',
      'b = BoldText("number", "$48,200", "+8.1%", "metric")',
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.html.includes("opui-text-block__secondary--positive"));
    assert.ok(result.html.includes("opui-numbers"));
  });

  it("renders EntityList rows with header and footer", () => {
    const source = [
      "root = Stack([list])",
      "list = EntityList([r1, r2], \"default\", h, f)",
      'h = { left: "Metric", right: "Value" }',
      'r1 = { left: "Latency", right: "42ms", rightVariant: "text" }',
      'r2 = { left: "Errors", right: "0", rightVariant: "number" }',
      'f = { left: "Total", right: "3" }',
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.html.includes("opui-entity-list__row--header"));
    assert.ok(result.html.includes("opui-entity-list__row--footer"));
    assert.ok(result.html.includes("opui-entity-list__cell-right--number"));
  });

  it("escapes html in text values", () => {
    const source = 'root = Stack([TextContent("<img src=x> & <b>")])';
    const result = render(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!result.html.includes("<img"));
    assert.ok(result.html.includes("&lt;img"));
  });

  it("rejects unsupported components with their names", () => {
    const source = [
      "root = Stack([tabs, pie])",
      "tabs = Tabs([TabItem(\"a\", \"A\", [TextContent(\"x\")])])",
      "pie = PieChart([\"a\"], [1])",
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("PieChart"));
    assert.ok(result.error.includes("TabItem"));
    assert.ok(result.error.startsWith("preview does not support"));
  });

  it("rejects the image variant of ListBlock", () => {
    const source = 'root = Stack([ListBlock([ListItem("a")], "image")])';
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("image variant"));
  });

  it("rejects reactive expressions", () => {
    const source = [
      "root = Stack([c])",
      'c = Callout("info", "T", "D", $vis)',
      "$vis = true",
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("reactive"));
  });

  it("rejects Query statements", () => {
    const source = [
      "root = Stack([t])",
      "t = TextContent(q.data)",
      'q = Query("tool", {})',
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("Query"));
  });

  it("rejects unknown components", () => {
    const source = 'root = Stack([Mystery("x")])';
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("display-only library"));
  });

  it("rejects truncated programs", () => {
    const source = 'root = Stack([TextContent("x"';
    const result = render(source);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("truncated"));
  });

  it("rejects programs without a root", () => {
    const result = render("");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("root"));
  });

  it("rejects programs failing prop validation", () => {
    const source = 'root = Stack([CodeBlock("only-language")])';
    const result = render(source);
    assert.equal(result.ok, false);
  });

  it("supports each advertised component without rejection", () => {
    const source = [
      "root = Stack([c, s, u])",
      'c = Card([ch], "card", "row", "l")',
      'ch = CardHeader("Title", "Subtitle")',
      "s = Separator(\"vertical\")",
      'u = Stack([t], "column", "s")',
      't = Tag("beta")',
    ].join("\n");
    const result = render(source);
    assert.equal(result.ok, true);
  });
});

describe("SUPPORTED_COMPONENTS", () => {
  it("lists the lightweight display set", () => {
    assert.deepEqual([...SUPPORTED_COMPONENTS].sort(), [
      "BoldText",
      "Callout",
      "Card",
      "CardHeader",
      "CodeBlock",
      "Col",
      "EntityList",
      "InlineHeader",
      "ListBlock",
      "ListItem",
      "Separator",
      "Stack",
      "Table",
      "Tag",
      "TagBlock",
      "Text",
      "TextCallout",
      "TextContent",
    ]);
  });
});

describe("inlineMarkdown", () => {
  it("styles bold, italic, and code while escaping html", () => {
    const html = inlineMarkdown("**b** *i* `c` <br>&");
    assert.ok(html.includes("<strong>b</strong>"));
    assert.ok(html.includes("<em>i</em>"));
    assert.ok(html.includes("<code>c</code>"));
    assert.ok(html.includes("&lt;br&gt;&amp;"));
  });

  it("keeps single newlines as breaks and blank lines as paragraphs", () => {
    const html = inlineMarkdown("a\nb\n\nc");
    assert.ok(html.includes("a<br>b"));
    assert.equal(html.match(/<p>/g)?.length, 2);
  });
});

/** Bun executes the CLI entry directly — no node shebang involved. */
function cliEntry(agentDir: string): string {
  return join(agentDir, "node_modules", "@openuidev", "cli", "dist", "index.js");
}