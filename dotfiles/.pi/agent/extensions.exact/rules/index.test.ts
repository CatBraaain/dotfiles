import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rulesExtension, {
  activateRulesForFile,
  buildRulesMessage,
  buildRulesWidgetLines,
  createRuleState,
  discoverRules,
  RULES_STATUS_KEY,
  markRulesInjected,
  matchesPathGlob,
  newlyActivatedRules,
  updateRulesWidget,
  type Rule,
} from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "source:rule.md",
    filePath: "/project/.pi/agent/rules/rule.md",
    displayPath: ".pi/agent/rules/rule.md",
    relativePath: "rule.md",
    name: "rule",
    paths: undefined,
    body: "rule body",
    ...overrides,
  };
}

async function withTemporaryDirectory(test: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rules-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRule(directory: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(directory, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
}

describe("rule discovery", () => {
  it("discovers supported local rule files recursively in the documented order", async () => {
    await withTemporaryDirectory(async (projectRoot) => {
      await writeRule(projectRoot, ".pi/agent/rules/nested/pi.md", "pi");
      await writeRule(projectRoot, ".claude/rules/claude.md", "claude");
      await writeRule(projectRoot, ".cursor/rules/cursor.mdc", "cursor");
      await writeRule(projectRoot, ".cursor/rules/ignored.md", "ignored");
      await writeRule(projectRoot, ".devin/rules/devin.md", "devin");
      await writeRule(projectRoot, ".windsurf/rules/windsurf.md", "windsurf");

      const rules = await discoverRules(projectRoot, join(projectRoot, "home"));

      assert.deepEqual(
        rules.map((discoveredRule) => discoveredRule.displayPath),
        [
          ".pi/agent/rules/nested/pi.md",
          ".claude/rules/claude.md",
          ".cursor/rules/cursor.mdc",
          ".devin/rules/devin.md",
          ".windsurf/rules/windsurf.md",
        ],
      );
    });
  });

  it("discovers global pi, Claude Code, and Windsurf rules after all local rules", async () => {
    await withTemporaryDirectory(async (directory) => {
      const projectRoot = join(directory, "project");
      const homeDirectory = join(directory, "home");
      await mkdir(projectRoot, { recursive: true });
      await writeRule(homeDirectory, ".pi/agent/rules/pi.md", "pi");
      await writeRule(homeDirectory, ".claude/rules/claude.md", "claude");
      await writeRule(homeDirectory, ".codeium/windsurf/memories/global_rules.md", "windsurf");

      const rules = await discoverRules(projectRoot, homeDirectory);

      assert.deepEqual(
        rules.map((discoveredRule) => discoveredRule.displayPath),
        [
          "~/.pi/agent/rules/pi.md",
          "~/.claude/rules/claude.md",
          "~/.codeium/windsurf/memories/global_rules.md",
        ],
      );
    });
  });

  it("uses the first rule when multiple sources have the same relative path", async () => {
    await withTemporaryDirectory(async (projectRoot) => {
      await writeRule(projectRoot, ".pi/agent/rules/shared.md", "pi body");
      await writeRule(projectRoot, ".claude/rules/shared.md", "Claude body");
      await writeRule(projectRoot, ".devin/rules/shared.md", "Windsurf body");

      const rules = await discoverRules(projectRoot, join(projectRoot, "home"));

      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.body, "pi body");
    });
  });
});

describe("rule parsing", () => {
  it("removes YAML frontmatter and keeps a rule without paths always active", async () => {
    await withTemporaryDirectory(async (projectRoot) => {
      await writeRule(
        projectRoot,
        ".pi/agent/rules/always.md",
        "---\ntitle: Always\n---\n\nAlways body",
      );

      const [alwaysRule] = await discoverRules(projectRoot, join(projectRoot, "home"));

      assert.equal(alwaysRule?.body, "\nAlways body");
      assert.equal(alwaysRule?.paths, undefined);
      assert.equal(createRuleState([alwaysRule!]).activeRuleIds.has(alwaysRule!.id), true);
    });
  });

  it("keeps an empty paths array always active", async () => {
    await withTemporaryDirectory(async (projectRoot) => {
      await writeRule(projectRoot, ".pi/agent/rules/always.md", "---\npaths: []\n---\nbody");

      const [alwaysRule] = await discoverRules(projectRoot, join(projectRoot, "home"));

      assert.deepEqual(alwaysRule?.paths, []);
      assert.equal(createRuleState([alwaysRule!]).activeRuleIds.has(alwaysRule!.id), true);
    });
  });

  it("excludes a rule with malformed frontmatter with a warning, without disabling other rules", async () => {
    await withTemporaryDirectory(async (projectRoot) => {
      await writeRule(projectRoot, ".pi/agent/rules/broken.md", "---\npaths: [\n---\nbroken");
      await writeRule(projectRoot, ".pi/agent/rules/valid.md", "valid");

      const warningMessages: string[] = [];
      const rules = await discoverRules(projectRoot, join(projectRoot, "home"), (message) => {
        warningMessages.push(message);
      });

      assert.deepEqual(
        rules.map((discoveredRule) => discoveredRule.name),
        ["valid"],
      );
      assert.deepEqual(warningMessages, [
        "Skipped rule .pi/agent/rules/broken.md: malformed frontmatter",
      ]);
    });
  });
});

describe("path matching and activation", () => {
  it("matches a top-level and nested TypeScript file with src/**/*.ts", () => {
    assert.equal(matchesPathGlob("src/index.ts", "src/**/*.ts"), true);
    assert.equal(matchesPathGlob("src/components/Button.ts", "src/**/*.ts"), true);
  });

  it("does not match a JavaScript file or a file outside src", () => {
    assert.equal(matchesPathGlob("src/index.js", "src/**/*.ts"), false);
    assert.equal(matchesPathGlob("tests/index.ts", "src/**/*.ts"), false);
  });

  it("activates matching rules after read, write, or edit target paths", () => {
    const state = createRuleState([
      rule({ id: "source:typescript.md", paths: ["src/**/*.ts"] }),
      rule({ id: "source:tests.md", paths: ["tests/**/*.ts"] }),
    ]);

    activateRulesForFile(state, "/project/src/index.ts", "/project");

    assert.deepEqual([...state.activeRuleIds], ["source:typescript.md"]);
  });

  it("does not activate a rule for a project-external absolute path", () => {
    const state = createRuleState([rule({ paths: ["src/**/*.ts"] })]);

    activateRulesForFile(state, "/other/src/index.ts", "/project");

    assert.equal(state.activeRuleIds.size, 0);
  });
});

describe("rule injection", () => {
  it("treats rules without paths as newly activated at session start", () => {
    const alwaysRule = rule({ id: "source:always.md", paths: undefined });
    const state = createRuleState([alwaysRule]);

    assert.deepEqual(
      newlyActivatedRules(state).map((activatedRule) => activatedRule.id),
      ["source:always.md"],
    );
  });

  it("does not report injected rules as newly activated again", () => {
    const alwaysRule = rule({ id: "source:always.md", paths: undefined });
    const state = createRuleState([alwaysRule]);
    markRulesInjected(state, newlyActivatedRules(state));

    assert.deepEqual(newlyActivatedRules(state), []);
  });

  it("reports a path-gated rule as newly activated only after a matching file operation", () => {
    const typescriptRule = rule({ id: "source:typescript.md", paths: ["src/**/*.ts"] });
    const state = createRuleState([typescriptRule]);

    assert.deepEqual(newlyActivatedRules(state), []);

    activateRulesForFile(state, "/project/src/index.ts", "/project");
    assert.deepEqual(
      newlyActivatedRules(state).map((activatedRule) => activatedRule.id),
      ["source:typescript.md"],
    );

    markRulesInjected(state, newlyActivatedRules(state));
    assert.deepEqual(newlyActivatedRules(state), []);
  });
});

describe("context and status", () => {
  it("renders active rule paths and bodies in resolution order", () => {
    const rules = [
      rule({
        id: "first",
        displayPath: ".pi/agent/rules/first.md",
        name: "first",
        body: "First body",
      }),
      rule({
        id: "second",
        displayPath: ".claude/rules/second.md",
        name: "second",
        body: "Second body",
      }),
    ];

    const message = buildRulesMessage(rules);

    assert.ok(message);
    assert.ok(
      message.indexOf(".pi/agent/rules/first.md") < message.indexOf(".claude/rules/second.md"),
    );
    assert.ok(message.includes("First body"));
    assert.ok(message.includes("Second body"));
  });

  it("returns no message and clears the widget when no rules are active", () => {
    assert.equal(buildRulesMessage([]), undefined);
    assert.equal(buildRulesWidgetLines([]), undefined);
  });

  it("prefixes the rules line with the scroll emoji", () => {
    const lines = buildRulesWidgetLines([rule({ name: "typescript" })]);

    assert.deepEqual(lines, ["📜 rules: typescript"]);
  });

  it("adds a path when active rules have the same name", () => {
    assert.deepEqual(
      buildRulesWidgetLines([
        rule({
          id: "first",
          displayPath: ".pi/agent/rules/typescript.md",
          name: "typescript",
        }),
        rule({ id: "second", displayPath: ".claude/rules/typescript.md", name: "typescript" }),
      ]),
      [
        "📜 rules: typescript (.pi/agent/rules/typescript.md), typescript (.claude/rules/typescript.md)",
      ],
    );
  });
});

describe("widget rendering", () => {
  it("registers a widget line colored with the muted theme color", () => {
    const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
    const ui = {
      setWidget(key: string, content: unknown) {
        setWidgetCalls.push({ key, content });
      },
    };

    updateRulesWidget(ui as never, [rule({ name: "typescript" })]);

    assert.equal(setWidgetCalls[0]?.key, RULES_STATUS_KEY);

    type WidgetFactory = (
      tui: unknown,
      theme: { fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const fgCalls: Array<{ color: string; text: string }> = [];
    const grayify = (text: string): string => `<gray>${text}</gray>`;
    const widgetFactory = setWidgetCalls[0]!.content as WidgetFactory;
    const widget = widgetFactory(undefined, {
      fg: (color, text) => {
        fgCalls.push({ color, text });
        return grayify(text);
      },
    });
    const renderedLines = widget.render(100);

    assert.deepEqual(renderedLines, ["<gray>📜 rules: typescript</gray>"]);
    assert.deepEqual(fgCalls, [{ color: "muted", text: "📜 rules: typescript" }]);
  });

  it("truncates a long widget line to the available width", () => {
    const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
    const ui = {
      setWidget(key: string, content: unknown) {
        setWidgetCalls.push({ key, content });
      },
    };
    const availableWidth = 20;

    updateRulesWidget(ui as never, [
      rule({ name: "asking-format" }),
      rule({ name: "report-format" }),
      rule({ name: "working-files-strategy" }),
    ]);

    type WidgetFactory = (
      tui: unknown,
      theme: { fg(color: string, text: string): string },
    ) => { render(width: number): string[] };
    const widgetFactory = setWidgetCalls[0]!.content as WidgetFactory;
    const widget = widgetFactory(undefined, { fg: (_color, text) => text });
    const renderedWidgetLine = widget.render(availableWidth)[0] ?? "";

    assert.equal(visibleWidth(renderedWidgetLine), availableWidth);
  });

  it("clears the widget when no rules are active", () => {
    const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
    const ui = {
      setWidget(key: string, content: unknown) {
        setWidgetCalls.push({ key, content });
      },
    };

    updateRulesWidget(ui as never, []);

    assert.deepEqual(setWidgetCalls, [{ key: RULES_STATUS_KEY, content: undefined }]);
  });
});

describe("extension lifecycle", () => {
  it("registers session, tool result, and before-agent-start handlers", () => {
    const events: string[] = [];
    rulesExtension({
      on(event: string) {
        events.push(event);
      },
    } as never);

    assert.deepEqual(events, ["session_start", "tool_result", "before_agent_start"]);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed += 1;
    console.log(`ok - ${test.name}`);
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
