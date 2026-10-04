// Tests for the SYSTEM_PROMPT.yaml template renderer: parsing, {{VAR}}
// substitution, each-style list rendering, and the Pi-shaped default.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  DEFAULT_SKILLS_LIST,
  buildRuntimeVariables,
  parseSystemPromptTemplate,
  renderListSection,
  renderTemplate,
  type ListItem,
} from "./template.ts";

function item(partial: Partial<ListItem>): ListItem {
  return {
    name: "skill",
    description: "description",
    filePath: "/skills/skill/SKILL.md",
    ...partial,
  };
}

const RUNTIME_VARIABLES = buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "read" });

/** Every required section, defined as plain strings. */
const DEFAULT_SECTION_LINES = [
  '  preamble: "Hello {{CODING_AGENT}}"',
  "  tools: T",
  "  rules: R",
  "  docs: D",
  "  cwd: C",
  "  project_context: PC",
  "  skills:",
  '    each: "- {{name}}"',
];

/** A minimal valid canonical file: every required section defined. */
function fullYaml(sectionLines: string[] = DEFAULT_SECTION_LINES, header: string[] = []): string {
  return [...header, "sections:", ...sectionLines].join("\n");
}

describe("parseSystemPromptTemplate", () => {
  it("parses variables, string sections, and list sections", () => {
    const parsed = parseSystemPromptTemplate(
      fullYaml(
        [...DEFAULT_SECTION_LINES, '  extra: "X {{LANGUAGE}}"'],
        ["variables:", "  LANGUAGE: ja"],
      ),
    );
    assert.deepEqual(parsed.variables, { LANGUAGE: "ja" });
    assert.deepEqual(parsed.sections.preamble, "Hello {{CODING_AGENT}}");
    assert.deepEqual(parsed.sections.skills, { each: "- {{name}}" });
    assert.deepEqual(parsed.sections.extra, "X {{LANGUAGE}}");
  });

  it("accepts list sections on tools, rules, and project_context", () => {
    const parsed = parseSystemPromptTemplate(
      fullYaml([
        "  preamble: P",
        "  tools:",
        '    each: "- {{name}}: {{description}}"',
        '    empty: "(none)"',
        "  rules:",
        '    each: "- {{rule}}"',
        "  docs: D",
        "  cwd: C",
        "  project_context:",
        '    pre: "Head"',
        '    each: "b {{path}}"',
        '    join: "\\n\\n"',
        "  skills:",
        '    each: "- {{name}}"',
      ]),
    );
    assert.deepEqual(parsed.sections.tools, {
      each: "- {{name}}: {{description}}",
      empty: "(none)",
    });
    assert.deepEqual(parsed.sections.rules, { each: "- {{rule}}" });
    assert.deepEqual(parsed.sections.project_context, {
      pre: "Head",
      each: "b {{path}}",
      join: "\n\n",
    });
  });

  it("rejects a list section on a name without runtime data", () => {
    assert.throws(
      () =>
        parseSystemPromptTemplate(
          fullYaml([...DEFAULT_SECTION_LINES, "  gadgets:", '    each: "- {{x}}"']),
        ),
      /list sections support skills, tools, rules, and project_context only/,
    );
  });

  it("rejects a missing required section and names it", () => {
    const withoutDocs = DEFAULT_SECTION_LINES.filter((line) => !line.startsWith("  docs:"));
    assert.throws(
      () => parseSystemPromptTemplate(fullYaml(withoutDocs)),
      /missing required section: docs/,
    );
    const withoutPreamble = DEFAULT_SECTION_LINES.filter((line) => !line.startsWith("  preamble:"));
    assert.throws(
      () => parseSystemPromptTemplate(fullYaml(withoutPreamble)),
      /missing required section: preamble/,
    );
  });

  it("rejects an empty or comment-only document as missing sections", () => {
    assert.throws(() => parseSystemPromptTemplate(""), /missing required section: preamble/);
    assert.throws(() => parseSystemPromptTemplate("# comments only\n"), /missing required section/);
  });

  it("rejects a non-mapping top level", () => {
    assert.throws(() => parseSystemPromptTemplate("- a\n"), /top level/);
  });

  it("rejects invalid section and variable names", () => {
    assert.throws(
      () => parseSystemPromptTemplate("sections:\n  Has Space: x\n"),
      /invalid section name/,
    );
    assert.throws(
      () => parseSystemPromptTemplate("variables:\n  HAS-DASH: x\n"),
      /invalid variable name/,
    );
  });

  it("rejects a list section without each", () => {
    assert.throws(
      () => parseSystemPromptTemplate("sections:\n  skills:\n    pre: x\n"),
      /"each" template/,
    );
  });

  it("rejects non-string variable values", () => {
    assert.throws(() => parseSystemPromptTemplate("variables:\n  COUNT: 3\n"), /must be a string/);
  });
});

describe("renderTemplate", () => {
  it("substitutes every variable reference", () => {
    const rendered = renderTemplate("A {{ONE}} B {{TWO}}", { ONE: "1", TWO: "2" });
    assert.equal(rendered, "A 1 B 2");
  });

  it("substitutes every variable reference including lowercase item fields", () => {
    const rendered = renderTemplate("A {{ONE}} B {{name}}", { ONE: "1", name: "x" });
    assert.equal(rendered, "A 1 B x");
  });

  it("throws on an undefined variable and names it", () => {
    assert.throws(
      () => renderTemplate("{{MISSING}}", {}),
      /Undefined template variable: \{\{MISSING\}\}/,
    );
  });
});

describe("buildRuntimeVariables", () => {
  it("provides the coding agent and both skill-read variables", () => {
    const read = buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "read" });
    assert.deepEqual(read, {
      CODING_AGENT: "pi",
      FILE_READ_TOOL: "read",
      SKILL_READ_PHRASE: "the read tool to load",
    });
    const bash = buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "bash" });
    assert.equal(bash.FILE_READ_TOOL, "bash");
    assert.equal(bash.SKILL_READ_PHRASE, "bash to load");
  });

  it("omits model and provider when unknown", () => {
    const variables = buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "read" });
    assert.equal("MODEL" in variables, false);
    assert.equal("PROVIDER" in variables, false);
  });

  it("includes model and provider when known", () => {
    const variables = buildRuntimeVariables({
      codingAgent: "pi",
      model: "gpt-x",
      provider: "openai",
    });
    assert.equal(variables.MODEL, "gpt-x");
    assert.equal(variables.PROVIDER, "openai");
  });

  it("includes cwd and the pi doc paths when provided", () => {
    const variables = buildRuntimeVariables({
      codingAgent: "pi",
      cwd: "/home/user/project",
      readmePath: "/pi/README.md",
      docsPath: "/pi/docs",
      examplesPath: "/pi/examples",
    });
    assert.equal(variables.CWD, "/home/user/project");
    assert.equal(variables.README_PATH, "/pi/README.md");
    assert.equal(variables.DOCS_PATH, "/pi/docs");
    assert.equal(variables.EXAMPLES_PATH, "/pi/examples");
  });

  it("omits cwd and the doc paths when unknown", () => {
    const variables = buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "read" });
    assert.equal("CWD" in variables, false);
    assert.equal("README_PATH" in variables, false);
    assert.equal("DOCS_PATH" in variables, false);
    assert.equal("EXAMPLES_PATH" in variables, false);
  });
});

describe("renderListSection", () => {
  const definition = {
    pre: "Header {{CODING_AGENT}}",
    each: "- {{name}}: {{description}}",
    post: "Footer",
  };

  it("joins pre, rendered items, and post with newlines", () => {
    const rendered = renderListSection(
      definition,
      [item({ name: "a" }), item({ name: "b" })],
      RUNTIME_VARIABLES,
    );
    assert.equal(rendered, "Header pi\n- a: description\n- b: description\nFooter");
  });

  it("honors a custom join string", () => {
    const rendered = renderListSection(
      { each: "- {{name}}", join: "\n---\n" },
      [item({ name: "a" }), item({ name: "b" })],
      {},
    );
    assert.equal(rendered, "- a\n---\n- b");
  });

  it("joins pre, body, and post with the custom join", () => {
    const rendered = renderListSection(
      { pre: "Head", each: "<{{name}}>", join: "\n\n" },
      [item({ name: "a" }), item({ name: "b" })],
      {},
    );
    assert.equal(rendered, "Head\n\n<a>\n\n<b>");
  });

  it("escapes XML-special characters in item fields only", () => {
    const rendered = renderListSection(
      { each: "{{description}}" },
      [item({ description: "a & b <c>" })],
      {},
    );
    assert.equal(rendered, "a &amp; b &lt;c&gt;");
  });

  it("leaves item fields raw with escapeItems: false", () => {
    const rendered = renderListSection(
      { each: "{{description}}" },
      [item({ description: "a & b <c>" })],
      {},
      { escapeItems: false },
    );
    assert.equal(rendered, "a & b <c>");
  });

  it("renders empty as the body when there are no items", () => {
    const rendered = renderListSection(
      { each: "- {{name}}", empty: "(none)", post: "\nEpilogue" },
      [],
      {},
    );
    assert.equal(rendered, "(none)\n\nEpilogue");
  });

  it("drops empty pre and post parts", () => {
    const rendered = renderListSection({ each: "- {{name}}" }, [item({ name: "a" })], {});
    assert.equal(rendered, "- a");
  });

  it("throws when an item template references an unknown variable", () => {
    assert.throws(
      () => renderListSection({ each: "{{NAME}}" }, [item({})], {}),
      /Undefined template variable/,
    );
  });
});

describe("DEFAULT_SKILLS_LIST", () => {
  it("writes the read-tool sentence", () => {
    const rendered = renderListSection(
      DEFAULT_SKILLS_LIST,
      [item({ name: "code" })],
      buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "read" }),
    );
    assert.match(
      rendered,
      /^The following skills provide specialized instructions for specific tasks\.\nUse the read tool to load a skill's file/,
    );
  });

  it("writes the bash sentence", () => {
    const rendered = renderListSection(
      DEFAULT_SKILLS_LIST,
      [item({ name: "code" })],
      buildRuntimeVariables({ codingAgent: "pi", fileReadTool: "bash" }),
    );
    assert.match(rendered, /\nUse bash to load a skill's file/);
  });

  it("wraps items in the available_skills block", () => {
    const rendered = renderListSection(DEFAULT_SKILLS_LIST, [item({})], RUNTIME_VARIABLES);
    assert.match(rendered, /\n<available_skills>\n  <skill>\n/);
    assert.ok(rendered.endsWith("</available_skills>"));
  });
});
