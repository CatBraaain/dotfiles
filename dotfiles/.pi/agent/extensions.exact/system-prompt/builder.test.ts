// Byte-equality tests for the ported builder against the installed Pi as
// the oracle. The oracle is the workspace-installed
// @earendil-works/pi-coding-agent (devDependency, same package the extension
// resolves at test time); deep imports bypass the package export map, so the
// oracle module is reached through its file URL.

import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import {
  buildSystemPrompt,
  buildSystemPromptSections,
  formatSkillsForPrompt,
  normalizeBuildSystemPromptOptions,
} from "./builder.ts";

const piPackageRootUrl = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
const oracle = await import(new URL("dist/core/system-prompt.js", piPackageRootUrl).href);

function skill(partial: Partial<Skill>): Skill {
  return {
    name: "skill",
    description: "description",
    filePath: "/skills/skill/SKILL.md",
    baseDir: "/skills/skill",
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
    ...partial,
  };
}

function assertMatchesOracle(input: BuildSystemPromptOptions): void {
  const ownSections = buildSystemPromptSections(input);
  const oracleSections = oracle.buildSystemPromptSections(input);
  assert.deepEqual(ownSections, oracleSections);
  assert.equal(buildSystemPrompt(input), oracle.buildSystemPrompt(input));
}

function richOptions(): BuildSystemPromptOptions {
  return {
    cwd: "/home/user/project",
    selectedTools: ["read", "edit", "write", "bash"],
    toolSnippets: {
      read: "Read the contents of a file",
      edit: "Edit a single file using exact text replacement",
      write: "Write content to a file",
      bash: "Execute a bash command",
    },
    toolGuidelines: {
      read: ["Check the current state before editing"],
      bash: ["Prefer read-only inspection first"],
    },
    promptGuidelines: ["Answer in Japanese"],
    appendSystemPrompt: "Extra standing instructions.",
    contextFiles: [{ path: "AGENTS.md", content: "# Guidelines\n\nFollow the repo rules." }],
    skills: [skill({ name: "coding", description: "Coding standards for this repo" })],
    sections: { extra_guidance: "Additional guidance section." },
  };
}

describe("builder matches the installed Pi", () => {
  it("reproduces sections and full prompt for a rich default configuration", () => {
    assertMatchesOracle(richOptions());
  });

  it("reproduces the tool-less default tool list", () => {
    assertMatchesOracle({ cwd: "/w" });
  });

  it("builds no tool list when no selected tool has a snippet", () => {
    assertMatchesOracle({ cwd: "/w", selectedTools: ["read"], toolSnippets: {} });
    const sections = buildSystemPromptSections({ cwd: "/w", selectedTools: ["read"] });
    assert.match(sections.tools ?? "", /\(none\)\n\nIn addition to the tools above/);
  });

  it("reproduces every bash/powershell file-operation rule variant", () => {
    assertMatchesOracle({ cwd: "/w", selectedTools: ["bash"] });
    assertMatchesOracle({ cwd: "/w", selectedTools: ["powershell"] });
    assertMatchesOracle({ cwd: "/w", selectedTools: ["bash", "powershell"] });
    assertMatchesOracle({ cwd: "/w", selectedTools: ["bash", "grep"] });
    assertMatchesOracle({ cwd: "/w", selectedTools: ["bash", "find", "ls"] });
  });

  it("keeps the selected-tool order in the tools section", () => {
    const options = richOptions();
    const reordered = { ...options, selectedTools: ["bash", "read", "edit", "write"] };
    assertMatchesOracle(reordered);
  });

  it("replaces the preamble with customPrompt and drops tools/rules/docs", () => {
    assertMatchesOracle({ ...richOptions(), customPrompt: "You are a pirate. Arrr." });
  });

  it("treats an empty customPrompt as unset", () => {
    assertMatchesOracle({ ...richOptions(), customPrompt: "" });
  });

  it("reproduces addendum omission when appendSystemPrompt is empty", () => {
    const options = richOptions();
    assertMatchesOracle({ ...options, appendSystemPrompt: "" });
    assert.equal("addendum" in buildSystemPromptSections(options), true);
  });

  it("reproduces multi-file project context with XML-special characters", () => {
    assertMatchesOracle({
      cwd: "/w",
      contextFiles: [
        { path: "a.md", content: "a & b < c > \"d\" 'e'" },
        { path: "sub/b.md", content: "line1\n\nline2" },
      ],
    });
  });

  it("escapes XML-special characters in skill fields", () => {
    assertMatchesOracle({
      cwd: "/w",
      selectedTools: ["read"],
      skills: [
        skill({
          name: `a&b <c> "d" 'e'`,
          description: `desc & <tag> "quote" 'apos'`,
          filePath: "/skills/a & b/SKILL.md",
        }),
      ],
    });
  });

  it("builds the bash variant of the skills section when read is not selected", () => {
    assertMatchesOracle({
      cwd: "/w",
      selectedTools: ["bash"],
      skills: [skill({ name: "bash-only" })],
    });
    const bashVariant = formatSkillsForPrompt([skill({ name: "bash-only" })], "bash");
    assert.match(bashVariant, /Use bash to load a skill's file/);
  });

  it("omits the skills section when no tool can read skill files", () => {
    const options: BuildSystemPromptOptions = {
      cwd: "/w",
      selectedTools: ["edit"],
      skills: [skill({ name: "invisible" })],
    };
    assertMatchesOracle(options);
    assert.equal("skills" in buildSystemPromptSections(options), false);
  });

  it("omits disabled skills and drops the section when all are disabled", () => {
    assertMatchesOracle({
      cwd: "/w",
      selectedTools: ["read"],
      skills: [skill({ name: "visible" }), skill({ name: "hidden", disableModelInvocation: true })],
    });
    const allDisabled = formatSkillsForPrompt([
      skill({ name: "hidden", disableModelInvocation: true }),
    ]);
    assert.equal(allDisabled, "");
  });

  it("trims and deduplicates rules including the fixed ones", () => {
    assertMatchesOracle({
      cwd: "/w",
      selectedTools: ["read"],
      toolGuidelines: { read: ["  Be concise in your responses  ", "", "unique rule"] },
      promptGuidelines: ["unique rule", "second rule"],
    });
  });

  it("applies custom sections after cwd and skips empty values", () => {
    assertMatchesOracle({
      cwd: "/w",
      sections: { dynamic: "D", empty: "" },
    });
  });

  it("lets custom sections override built-in ones and keep their position", () => {
    assertMatchesOracle({
      cwd: "/w",
      sections: { cwd: "/overridden", rules: "- custom rules" },
    });
  });

  it("normalizes backslashes in cwd", () => {
    assertMatchesOracle({ cwd: "C:\\Users\\user\\project" });
  });

  it("returns a forced prompt verbatim and keeps sections structured", () => {
    const forced = "Exact forced text.\n\nLine two.";
    const options = { ...richOptions(), forceSystemPrompt: forced };
    assert.equal(buildSystemPrompt(options), forced);
    assertMatchesOracle(options);
  });

  it("keeps unicode and multi-byte content byte-identical", () => {
    assertMatchesOracle({
      ...richOptions(),
      customPrompt: "日本語の指示 🚀 émoji",
      appendSystemPrompt: "追記: 常体で書く",
    });
  });

  it("rejects invalid custom section names like the installed Pi", () => {
    for (const name of ["Preamble", "1abc", "has space", "preamble", "a/b"]) {
      assert.throws(
        () => buildSystemPromptSections({ cwd: "/w", sections: { [name]: "x" } }),
        /Invalid system prompt section name/,
      );
      assert.throws(
        () => oracle.buildSystemPromptSections({ cwd: "/w", sections: { [name]: "x" } }),
        /Invalid system prompt section name/,
      );
    }
  });
});

describe("normalizeBuildSystemPromptOptions port", () => {
  it("fills the same defaults and copies every collection", () => {
    const input = richOptions();
    const own = normalizeBuildSystemPromptOptions(input);
    const reference = oracle.normalizeBuildSystemPromptOptions(input);
    assert.deepEqual(own, reference);
    own.selectedTools.push("mutated");
    own.sections.dynamic = "mutated";
    own.skills[0]!.name = "mutated";
    assert.deepEqual(oracle.normalizeBuildSystemPromptOptions(input), reference);
  });

  it("defaults selectedTools to the standard set", () => {
    assert.deepEqual(normalizeBuildSystemPromptOptions({ cwd: "/w" }).selectedTools, [
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });
});
