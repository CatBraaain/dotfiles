import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "bun:test";
import { createParser, type ElementNode } from "@openuidev/lang-core";
import { displayLibrary, displayPromptOptions } from "./library.data";
import { openuiInstructions, opuiSkill } from "./prompt";
import { validateOpenuiLang } from "./render";
import { SUPPORTED_COMPONENTS } from "./supported-components";

let fixtureDir: string;
beforeAll(() => {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  fixtureDir = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/prompt-");
});
beforeEach(() => {
  writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
  writeFileSync(join(fixtureDir, "prompt-options.json"), JSON.stringify(displayPromptOptions));
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe("openuiInstructions", () => {
  it("embeds the markdown preamble and static syntax without streaming or action defaults", () => {
    const prompt = openuiInstructions(fixtureDir);
    assert.ok(prompt.includes("```openui-lang"));
    assert.ok(prompt.includes("answers in markdown"));
    assert.ok(prompt.includes("Arguments are POSITIONAL"));
    for (const unsupported of [
      "## Action",
      "ActionExpression",
      "$binding",
      "## Hoisting",
      "streaming",
      "forms for input",
      "@Each",
      "@Filter",
      "@Count",
      "real image URL",
      "reactive $boolean",
    ]) {
      assert.ok(!prompt.includes(unsupported), unsupported);
    }
    assert.ok(prompt.includes("data:形式"));
    assert.ok(prompt.includes("メッセージ確定後"));
  });

  it("keeps all renderer component signatures and display-only union members", () => {
    const prompt = openuiInstructions(fixtureDir);
    const names = [...prompt.matchAll(/^([A-Z]\w*)\(/gm)].map((match) => match[1]);
    const expectedNames = [...SUPPORTED_COMPONENTS].sort();
    assert.deepEqual(names.sort(), expectedNames);
    const card = prompt.split("\n").find((line) => line.startsWith("Card("));
    assert.ok(card?.includes("TextContent | MarkDownRenderer"));
    assert.ok(card?.includes("Tabs | Carousel | Stack"));
    assert.ok(!card?.includes("Buttons | Form"));
  });

  it("removes deselected component types from signatures", () => {
    const spec = displayLibrary.toSpec();
    delete spec.components.TextContent;
    writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(spec));
    const prompt = openuiInstructions(fixtureDir);
    assert.ok(!prompt.includes("TextContent(text:"));
    const card = prompt.split("\n").find((line) => line.startsWith("Card("));
    assert.ok(card?.includes("MarkDownRenderer"));
    assert.ok(!card?.includes("TextContent"));
  });

  it("preserves unavailable argument slots and later display arguments", () => {
    const prompt = openuiInstructions(fixtureDir);
    assert.match(prompt, /SnippetCardBlock\(.*action\?: null, gap\?: number \| string\)/);
    assert.match(prompt, /Callout\(.*visible\?: null\)/);
    assert.match(prompt, /ListItem\(.*actionLabel\?: null, action\?: null\)/);
    assert.match(prompt, /CompositeCardItem\(.*button\?: null/);
    assert.match(prompt, /Col\(label: string, data: any, type\?: "string" \| "number"\)/);
    const spec = displayLibrary.toSpec();
    const parsed = createParser(displayLibrary.toJSONSchema(), spec.root).parse(
      'root = Stack([SnippetCardBlock([SnippetCardItem(null, IconText(Icon("star"), null, null, "A")), SnippetCardItem(null, IconText(Icon("star"), null, null, "B"))], "grid", true, null, 12)])',
    );
    assert.deepEqual(parsed.meta.errors, []);
    const children = parsed.root?.props.children as ElementNode[];
    assert.equal(children[0]?.props.action, null);
    assert.equal(children[0]?.props.gap, 12);
  });

  it("retains useful static descriptions and rules while dropping unsupported clauses", () => {
    const prompt = openuiInstructions(fixtureDir);
    assert.ok(prompt.includes("Column definition — holds label + data array"));
    assert.ok(prompt.includes("size small renders a compact list."));
    assert.ok(prompt.includes("realistic/plausible data"));
    assert.ok(prompt.includes("Always pass a category to Icon"));
    for (const unsupported of [
      "clickable",
      "auto-dismisses",
      "Save Changes",
      "plucked arrays",
      "Shared filter",
      "modal preview",
      "before inventing ternary",
    ]) {
      assert.ok(!prompt.includes(unsupported), unsupported);
    }
  });

  it("includes every existing static example and validates each complete program", () => {
    const prompt = openuiInstructions(fixtureDir);
    for (const example of displayPromptOptions.examples) {
      assert.ok(prompt.includes(example));
      const source = example.slice(example.search(/^[\w$]+\s*=/m));
      assert.deepEqual(validateOpenuiLang(source, fixtureDir), { ok: true }, example);
    }
  });

  for (const source of [
    '$show = true\nroot = Stack([TextContent("state")])',
    'root = Stack([PieChart(["A"], [@Count([1, 2])])])',
    'root = Stack([TextContent(true ? "A" : "B")])',
    'root = Stack([TextContent("" + 1)])',
    "root = Stack([TextContent(missing)])",
    'root = Stack([Input("name")])',
    'root = Stack([TextContent(result)])\nresult = Query("missing", {}, "")',
  ]) {
    it(`omits an example that cannot be rendered statically: ${source}`, () => {
      writeFileSync(
        join(fixtureDir, "prompt-options.json"),
        JSON.stringify({ examples: [`対象外例:\n\n${source}`], additionalRules: [] }),
      );
      assert.ok(!openuiInstructions(fixtureDir).includes("対象外例"));
    });
  }

  it("keeps ordinary data strings even when they name unsupported features", () => {
    const example =
      '文字列の例:\n\nroot = Stack([TextContent("Query Action streaming @Each forms")])';
    writeFileSync(
      join(fixtureDir, "prompt-options.json"),
      JSON.stringify({ examples: [example], additionalRules: [] }),
    );
    assert.ok(openuiInstructions(fixtureDir).includes(example));
  });

  for (const component of [
    'Image("alt", "__SOURCE__")',
    'ImageBlock("__SOURCE__")',
    'ImageGallery([{src: "__SOURCE__", alt: "alt"}])',
    'CompositeCardBlock([CompositeCardItem(null, ImageText("__SOURCE__", null, "A")), CompositeCardItem(null, Text(null, "B"))])',
    'CompositeCardBlock([CompositeCardItem(null, ImageTextLarge("__SOURCE__", null, "A")), CompositeCardItem(null, Text(null, "B"))])',
    'ContextCardBlock([ContextCardItem(null, "A", null, null, "__SOURCE__"), ContextCardItem(null, "B")])',
    'VisualCardBlock([VisualCardItem(BoldText(null, "A"), null, "__SOURCE__"), VisualCardItem(BoldText(null, "B"))])',
    'ListBlock([ListItem("A", null, {src: "__SOURCE__", alt: "alt"})], "image")',
  ]) {
    it(`accepts embedded image examples and omits external image examples in ${component}`, () => {
      const embedded =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const externalSource = `root = Stack([${component.replaceAll("__SOURCE__", "https://example.invalid/image.png")}])`;
      const embeddedSource = `root = Stack([${component.replaceAll("__SOURCE__", embedded)}])`;
      for (const source of [externalSource, embeddedSource])
        assert.deepEqual(validateOpenuiLang(source, fixtureDir), { ok: true }, source);
      const externalExample = `外部画像例:\n\n${externalSource}`;
      const embeddedExample = `埋込画像例:\n\n${embeddedSource}`;
      writeFileSync(
        join(fixtureDir, "prompt-options.json"),
        JSON.stringify({ examples: [externalExample, embeddedExample], additionalRules: [] }),
      );
      const prompt = openuiInstructions(fixtureDir);
      assert.ok(!prompt.includes(externalExample));
      assert.ok(prompt.includes(embeddedExample));
    });
  }

  it("preserves URL text without treating it as an image reference", () => {
    const example =
      'URL文字列例:\n\nroot = Stack([TextContent("https://example.invalid/image.png"), Image("https://example.invalid/alt")])';
    writeFileSync(
      join(fixtureDir, "prompt-options.json"),
      JSON.stringify({ examples: [example], additionalRules: [] }),
    );
    assert.ok(openuiInstructions(fixtureDir).includes(example));
  });

  for (const reference of [
    "file:///etc/passwd",
    "blob:https://example.invalid/image",
    "./image.png",
  ]) {
    it(`omits an image example requiring blocked reference ${reference}`, () => {
      const example = `参照画像例:\n\nroot = Stack([Image("alt", "${reference}")])`;
      writeFileSync(
        join(fixtureDir, "prompt-options.json"),
        JSON.stringify({ examples: [example], additionalRules: [] }),
      );
      assert.ok(!openuiInstructions(fixtureDir).includes(example));
    });
  }

  it("propagates safe signature, description, note, example, and rule changes from both JSON inputs", () => {
    const previous = openuiInstructions(fixtureDir);
    const spec = structuredClone(displayLibrary.toSpec());
    spec.components.TextContent = {
      signature: "TextContent(text: string, emphasis?: boolean)",
      description: "更新した本文説明",
    };
    spec.components.Callout!.description += " 静的バナーの補足。";
    spec.componentGroups![0]!.notes![0] = "- 更新したレイアウト規則";
    spec.componentGroups![0]!.notes![4] = "- 静的な比較を並べる";
    spec.componentGroups![0]!.notes!.push("- 追加した静的規則");
    writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(spec));
    const example = '更新した例:\n\nroot = Stack([TextContent("updated")])';
    writeFileSync(
      join(fixtureDir, "prompt-options.json"),
      JSON.stringify({
        examples: [example],
        additionalRules: Array.from({ length: 8 }, (_, index) => `更新したデータ規則${index}`),
      }),
    );
    const current = openuiInstructions(fixtureDir);
    assert.notEqual(current, previous);
    for (const expected of [
      "emphasis?: boolean",
      "更新した本文説明",
      "静的バナーの補足",
      "更新したレイアウト規則",
      "追加した静的規則",
      "静的な比較を並べる",
      example,
      "更新したデータ規則5",
      "更新したデータ規則7",
    ]) {
      assert.ok(current.includes(expected), expected);
    }
    assert.ok(!current.includes(displayPromptOptions.examples[0]!));
  });

  it("projects upstream notes and rules independently of their array order", () => {
    const spec = structuredClone(displayLibrary.toSpec());
    for (const group of spec.componentGroups ?? []) group.notes?.reverse();
    writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(spec));
    writeFileSync(
      join(fixtureDir, "prompt-options.json"),
      JSON.stringify({
        ...displayPromptOptions,
        additionalRules: [...displayPromptOptions.additionalRules].reverse(),
      }),
    );
    const prompt = openuiInstructions(fixtureDir);
    assert.ok(prompt.includes("Always pass a category to Icon"));
    assert.ok(prompt.includes("Use nested Stacks"));
    assert.ok(!prompt.includes("@Filter"));
    assert.ok(!prompt.includes("before inventing ternary"));
    assert.ok(!prompt.includes("Image URLs must be real"));
  });

  it("preserves quoted type literals when they share names with excluded components", () => {
    const spec = displayLibrary.toSpec();
    spec.components.TextContent!.signature =
      'TextContent(text: "Form" | "Button", child?: Button | TextContent, footer?: {button?: Button, label?: string})';
    writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(spec));
    assert.ok(
      openuiInstructions(fixtureDir).includes(
        'TextContent(text: "Form" | "Button", child?: TextContent, footer?: {button?: null, label?: string})',
      ),
    );
  });

  it("wraps a deterministic generated body in skill frontmatter", () => {
    const skill = opuiSkill(fixtureDir);
    assert.ok(skill.startsWith("---\nname: openui-preview\n"));
    const body = skill.slice(skill.indexOf("\n---\n\n") + "\n---\n\n".length);
    assert.equal(body, openuiInstructions(fixtureDir) + "\n");
    assert.equal(opuiSkill(fixtureDir), skill);
    assert.ok(!skill.includes("references/openui-lang.md"));
  });
});
