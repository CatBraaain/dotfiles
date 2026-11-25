import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  ExtensionRunner,
  type BuildSystemPromptOptions,
  type Extension,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import systemPromptExtension from "./index.ts";
import { normalizeBuildSystemPromptOptions } from "./builder.ts";

const piPackageRootUrl = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
const oracle = await import(new URL("dist/core/system-prompt.js", piPackageRootUrl).href);

const documentationPathNames = ["PI_README_PATH", "PI_DOCS_PATH", "PI_EXAMPLES_PATH"] as const;
let originalEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    documentationPathNames.map((name) => [name, process.env[name]]),
  );
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Handler = (event: any, ctx: any) => unknown;

function captureHandlers(
  templatePath = () => "/system-prompt-tests/no-template/SYSTEM_PROMPT.yaml",
): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  systemPromptExtension(
    {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
    } as never,
    { templatePath },
  );
  return handlers;
}

/** Minimal Extension shape the runner reads at emit time (path + handlers). */
function extensionFrom(name: string, handlers: Map<string, Handler[]>): Extension {
  return { path: `/ext/${name}/index.ts`, handlers } as unknown as Extension;
}

/** The extension paired with its captured handlers, for direct event dispatch. */
interface LoadedExtension {
  extension: Extension;
  handlers: Map<string, Handler[]>;
}

function loadSystemPromptExtension(templatePath?: () => string): LoadedExtension {
  const handlers = captureHandlers(templatePath);
  return { extension: extensionFrom("system-prompt", handlers), handlers };
}

function runnerFor(extensions: Extension[]): ExtensionRunner {
  return new ExtensionRunner(extensions, {} as never, "/w", {} as never, {} as never);
}

/** Dispatch every registered session_start handler with the given context. */
async function dispatchSessionStart(loaded: LoadedExtension, ctx: unknown): Promise<void> {
  for (const handler of loaded.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "new" }, ctx);
  }
}

function richOptions(): BuildSystemPromptOptions & NormalizedBuildSystemPromptOptions {
  return {
    cwd: "/w",
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read", "edit"],
    hiddenTools: [],
    toolSnippets: { read: "Read files", edit: "Edit files" },
    toolGuidelines: { edit: ["Read the file before editing"] },
    promptGuidelines: ["Answer concisely"],
    appendSystemPrompt: "Standing addendum.",
    sections: {},
    contextFiles: [{ path: "AGENTS.md", content: "# Rules\n\nBe careful." }],
    skills: [
      {
        name: "coding",
        description: "Coding standards",
        filePath: "/skills/coding/SKILL.md",
        baseDir: "/skills/coding",
        sourceInfo: {} as never,
        disableModelInvocation: false,
      },
    ],
  };
}

describe("documentation asset environment", () => {
  it("leaves missing documentation path variables unset", () => {
    documentationPathNames.forEach((name) => {
      delete process.env[name];
    });

    captureHandlers();
    captureHandlers();

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    assert.deepEqual(actualPaths, [undefined, undefined, undefined]);
  });

  it("preserves inherited documentation path variables", () => {
    const inheritedPaths = documentationPathNames.map((name) => `/inherited/${name}`);
    documentationPathNames.forEach((name, index) => {
      process.env[name] = inheritedPaths[index];
    });

    captureHandlers();
    captureHandlers();

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    assert.deepEqual(actualPaths, inheritedPaths);
  });
});

describe("native prompt options", () => {
  const sections = {
    preamble: "Canonical preamble {{CODING_AGENT}}",
    tools: { each: "- {{name}}: {{description}}", empty: "(none)" },
    rules: { each: "- {{rule}}" },
    skills: { each: "{{name}}: {{SKILL_READ_PHRASE}}" },
    cwd: "{{CWD}}",
    project_context: { each: "{{content}}" },
  };

  async function render(raw: string | undefined, options = richOptions()) {
    const root = "/tmp/work/dotfiles";
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "system-prompt-"));
    const path = join(directory, "SYSTEM_PROMPT.yaml");
    try {
      if (raw !== undefined) writeFileSync(path, raw);
      const loaded = loadSystemPromptExtension(() => path);
      const warnings: string[] = [];
      const context = {
        hasUI: true,
        ui: { notify: (message: string) => warnings.push(message) },
      };
      await dispatchSessionStart(loaded, context);
      const start = await runnerFor([loaded.extension]).emitBeforeAgentStart(
        { messageType: "user", prompt: "Test" },
        options,
      );
      const updated = start.systemPromptOptions;
      return { updated, sections: oracle.buildSystemPromptSections(updated), warnings };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("passes the deployed template to native generation without docs", async () => {
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../.agents/SYSTEM_PROMPT.yaml",
    );
    const options = richOptions();
    const rendered = await render(readFileSync(path, "utf8"), options);
    const expected = oracle.buildSystemPromptSections(options);
    delete expected.docs;
    expected.preamble =
      "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
    expected.tools = expected.tools!.replace(
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "Additional tools may be available.",
    );
    expected.skills = expected.skills!.replace(
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    );
    assert.deepEqual(rendered.sections, expected);
    assert.deepEqual(rendered.updated.selectedTools, options.selectedTools);
    assert.equal(rendered.updated.forceSystemPrompt, undefined);
  });

  it("keeps other extensions' sections and preserves an explicit forced prompt", async () => {
    const options = {
      ...richOptions(),
      forceSystemPrompt: "Opaque force.",
      sections: { agent_instructions: "Agent rules", docs: "Other docs", extra: "Extra" },
    };
    const raw = YAML.stringify({ sections: { ...sections, agent_instructions: "Ignore" } });
    const rendered = await render(raw, options);
    assert.equal(rendered.updated.forceSystemPrompt, options.forceSystemPrompt);
    assert.equal(
      rendered.sections.agent_instructions,
      "<agent_instructions>\nAgent rules\n</agent_instructions>",
    );
    assert.equal(rendered.sections.docs, "<docs>\nOther docs\n</docs>");
    assert.equal(rendered.sections.extra, "<extra>\nExtra\n</extra>");
    assert.equal(rendered.sections.preamble, "Canonical preamble pi");
  });

  it("keeps explicitly blank sections and omits unavailable lists", async () => {
    const raw = YAML.stringify({ sections: { ...sections, preamble: "", docs: "" } });
    const rendered = await render(raw, { ...richOptions(), selectedTools: [], contextFiles: [] });
    assert.equal(rendered.sections.preamble, " ");
    assert.equal(rendered.sections.docs, "<docs>\n \n</docs>");
    assert.equal(rendered.sections.skills, undefined);
    assert.equal(rendered.sections.project_context, undefined);
    assert.equal(rendered.sections.tools, "<tools>\n(none)\n</tools>");
  });

  it("uses native generation when the template is missing or invalid", async () => {
    const options = normalizeBuildSystemPromptOptions(richOptions());
    const expected = oracle.buildSystemPromptSections(options);
    for (const raw of [
      undefined,
      "sections: [",
      YAML.stringify({ sections: { ...sections, cwd: "{{UNBOUND}}" } }),
    ]) {
      const rendered = await render(raw, options);
      assert.deepEqual(rendered.sections, expected);
    }
  });
});
