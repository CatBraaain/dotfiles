import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it } from "bun:test";
import { PROMPT_SECTION_NAME, opuiInstructions } from "./prompt";

/**
 * Minimal LibrarySpec covering the behaviors under test: interactive names
 * inside signatures (replaced by never), a display-only component, and the
 * CompositeCardItem button prop.
 */
const SPEC = {
  root: "Stack",
  components: {
    Card: {
      signature:
        'Card(children: (TextContent | MarkDownRenderer | Buttons | Form)[], variant?: "card" | "sunk") — Styled container',
    },
    CompositeCardItem: {
      signature: "CompositeCardItem(title: string, button?: Button) — Card body with action",
    },
    TextContent: {
      signature: 'TextContent(text: string, size?: "small" | "default") — Text block',
    },
  },
};

const PROMPT_OPTIONS = {
  examples: ["Example 1 — Table:\n\nroot = Stack([tbl])"],
  additionalRules: ["When asked about data, generate realistic/plausible data"],
};

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "openui-prompt-test-"));
  writeFileSync(join(fixtureDir, "spec.json"), JSON.stringify(SPEC));
  writeFileSync(join(fixtureDir, "prompt-options.json"), JSON.stringify(PROMPT_OPTIONS));
});

describe("opuiInstructions", () => {
  it("embeds openui-lang fenced-block preamble", () => {
    const prompt = opuiInstructions(fixtureDir);
    assert.ok(prompt.includes("```openui-lang"));
    assert.ok(prompt.includes("answers in markdown"));
  });

  it("drops the built-in Action section and ActionExpression explainer", () => {
    const prompt = opuiInstructions(fixtureDir);
    assert.ok(!prompt.includes("\n## Action"));
    assert.ok(!prompt.includes("Props typed `ActionExpression`"));
  });

  it("replaces interactive components in signatures with never", () => {
    const prompt = opuiInstructions(fixtureDir);
    const cardLine = prompt.split("\n").find((line) => line.startsWith("Card("));
    assert.ok(cardLine, "Card signature should be present");
    assert.ok(!cardLine.includes("Buttons"));
    assert.ok(!cardLine.includes("Form"));
    const compositeLine = prompt
      .split("\n")
      .find((line) => line.startsWith("CompositeCardItem("));
    assert.ok(compositeLine, "CompositeCardItem signature should be present");
    assert.ok(compositeLine.includes("button?: never"));
  });

  it("keeps display-only component names", () => {
    const prompt = opuiInstructions(fixtureDir);
    assert.ok(prompt.includes("TextContent("));
  });

  it("includes the prompt-options examples and rules", () => {
    const prompt = opuiInstructions(fixtureDir);
    assert.ok(prompt.includes("Example 1 — Table"));
    assert.ok(prompt.includes("realistic/plausible data"));
  });

  it("is stable across calls for the same directory", () => {
    assert.equal(opuiInstructions(fixtureDir), opuiInstructions(fixtureDir));
  });

  it("uses the openui-lang section name", () => {
    assert.equal(PROMPT_SECTION_NAME, "openui-lang");
  });
});
