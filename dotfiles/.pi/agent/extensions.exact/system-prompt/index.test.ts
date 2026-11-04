// Run-level tests using the installed ExtensionRunner. They verify the two
// request paths of the extension against the installed Pi's own section
// builder (same deep-import oracle as builder.test.ts):
//
// - Non-forced runs: the context_with_system handler swaps the assembled
//   text into the leading system message, adopts mid-run section patches,
//   and preserves tool declarations and later messages.
// - Forced runs: with a force-setting extension registered earlier (like
//   `agents`), the before_agent_start handler replaces the standard prefix
//   with its own build and keeps the suffix; on mismatch it does
//   nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import {
  ExtensionRunner,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type BuildSystemPromptOptions,
  type Extension,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import YAML from "yaml";
import systemPromptExtension, {
  assembleHeadContent,
  foldSystemMessages,
  type FoldedSystemState,
  type TemplateRunState,
} from "./index.ts";
import {
  buildSystemPrompt,
  buildSystemPromptSections,
  normalizeBuildSystemPromptOptions,
} from "./builder.ts";
import { parseSystemPromptTemplate, type SystemPromptTemplate } from "./template.ts";

const piPackageRootUrl = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
const oracle = await import(new URL("dist/core/system-prompt.js", piPackageRootUrl).href);

const documentationPathNames = ["PI_README_PATH", "PI_DOCS_PATH", "PI_EXAMPLES_PATH"] as const;
let originalEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    [...documentationPathNames, "PI_PACKAGE_DIR"].map((name) => [name, process.env[name]]),
  );
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Handler = (event: any, ctx: any) => unknown;

interface ShortcutRegistration {
  key: string;
  options: { description?: string; handler: (ctx: any) => unknown };
}

interface CommandRegistration {
  name: string;
  options: { description?: string; handler: (args: any, ctx: any) => unknown };
}

/** Everything the extension factory registers on the ExtensionAPI. */
interface CapturedRegistration {
  handlers: Map<string, Handler[]>;
  shortcuts: ShortcutRegistration[];
  commands: CommandRegistration[];
}

/** Capture the handlers, shortcuts, and commands the factory registers. */
function captureRegistration(
  templatePath = () => "/system-prompt-tests/no-template/SYSTEM_PROMPT.yaml",
): CapturedRegistration {
  // Run-level tests pin the baseline (template-free) prompt behavior. The
  // deployed ~/.agents/SYSTEM_PROMPT.yaml owns every required section and
  // wins over mid-run patches and custom overrides by design, so every test
  // instance reads from a path where no template exists. Template-active
  // behavior is covered by the fixture-based describes below.
  const handlers = new Map<string, Handler[]>();
  const shortcuts: ShortcutRegistration[] = [];
  const commands: CommandRegistration[] = [];
  systemPromptExtension(
    {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      registerShortcut(key: string, options: ShortcutRegistration["options"]) {
        shortcuts.push({ key, options });
      },
      registerCommand(name: string, options: CommandRegistration["options"]) {
        commands.push({ name, options });
      },
    } as never,
    { templatePath },
  );
  return { handlers, shortcuts, commands };
}

/** Capture the handlers the extension factory registers, like pi.on would. */
function captureHandlers(): Map<string, Handler[]> {
  return captureRegistration().handlers;
}

/** Minimal Extension shape the runner reads at emit time (path + handlers). */
function extensionFrom(name: string, handlers: Map<string, Handler[]>): Extension {
  return { path: `/ext/${name}/index.ts`, handlers } as unknown as Extension;
}

/** An extension that forces the prompt like `agents` does: current prompt + addendum. */
function forcingExtension(addendum: string): Extension {
  const handlers = new Map<string, Handler[]>([
    [
      "before_agent_start",
      [
        (event: any) => ({
          systemPrompt: event.systemPrompt + addendum,
        }),
      ],
    ],
  ]);
  return extensionFrom("forcing", handlers);
}

/** An extension that forces an unrelated opaque prompt (no standard prefix). */
function opaqueForcingExtension(text: string): Extension {
  const handlers = new Map<string, Handler[]>([
    ["before_agent_start", [() => ({ systemPrompt: text })]],
  ]);
  return extensionFrom("opaque-forcing", handlers);
}

/** The extension paired with its captured handlers, for direct event dispatch. */
interface LoadedExtension {
  extension: Extension;
  handlers: Map<string, Handler[]>;
}

function loadSystemPromptExtension(templatePath?: () => string): LoadedExtension {
  const handlers = captureRegistration(templatePath).handlers;
  return { extension: extensionFrom("system-prompt", handlers), handlers };
}

function runnerFor(extensions: Extension[]): ExtensionRunner {
  return new ExtensionRunner(extensions, {} as never, "/w", {} as never, {} as never);
}

interface ViewerCustomCall {
  factory: (
    tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
    theme: { fg: (token: string, text: string) => string; bold: (text: string) => string },
    keybindings: unknown,
    done: (result: void) => void,
  ) => { render: (width: number) => string[] };
  options: { overlay?: boolean } | undefined;
}

/** A recorded ctx.ui.setWidget request. */
interface WidgetCall {
  key: string;
  content: unknown;
  options: { placement?: string } | undefined;
}

/** Session-start context mock that records ctx.ui widget and custom requests. */
function sessionStartCtx(mode: "tui" | "rpc" | "json" | "print", prompt = "") {
  const customCalls: ViewerCustomCall[] = [];
  const widgetCalls: WidgetCall[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    getSystemPrompt: () => prompt,
    ui: {
      custom: (factory: ViewerCustomCall["factory"], options?: ViewerCustomCall["options"]) => {
        customCalls.push({ factory, options });
        return Promise.resolve(undefined);
      },
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        widgetCalls.push({ key, content, options });
      },
    },
  };
  return { ctx, customCalls, widgetCalls };
}

/** Dispatch every registered session_start handler with the given context. */
async function dispatchSessionStart(loaded: LoadedExtension, ctx: unknown): Promise<void> {
  for (const handler of loaded.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "new" }, ctx);
  }
}

/** Start a fresh session so the extension resets its run state. */
async function emitSessionStart(loaded: LoadedExtension): Promise<void> {
  // The runner has no session_start emit helper; dispatch to the handler directly.
  // A non-tui context keeps the session-start viewer out of these tests.
  for (const handler of loaded.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "new" }, sessionStartCtx("print"));
  }
}

function richOptions(): BuildSystemPromptOptions & NormalizedBuildSystemPromptOptions {
  return {
    cwd: "/w",
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read", "edit"],
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

function toolDeclaration(name: string, description: string): Tool {
  return { name, description, parameters: {} } as unknown as Tool;
}

/** A one-turn transcript whose head carries Pi's own build of `options`. */
function transcriptFor(options: BuildSystemPromptOptions): AgentMessage[] {
  const snippets = options.toolSnippets ?? {};
  return [
    {
      role: "system",
      content: "",
      sections: oracle.buildSystemPromptSections(options),
      toolsAdded: (options.selectedTools ?? []).map((name) =>
        toolDeclaration(name, snippets[name] ?? name),
      ),
      timestamp: 1,
    },
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 2 },
  ];
}

describe("documentation asset environment", () => {
  it("publishes host paths before template loading and before any run", () => {
    documentationPathNames.forEach((name) => {
      delete process.env[name];
    });

    captureRegistration(() => {
      throw new Error("Template lookup must wait for session_start");
    });

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    const expectedPaths = [getReadmePath(), getDocsPath(), getExamplesPath()];
    assert.deepEqual(actualPaths, expectedPaths);
  });

  it("overwrites inherited asset paths with host API paths", () => {
    documentationPathNames.forEach((name) => {
      process.env[name] = "/inherited/stale/path";
    });

    captureRegistration();

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    const expectedPaths = [getReadmePath(), getDocsPath(), getExamplesPath()];
    assert.deepEqual(actualPaths, expectedPaths);
  });

  it("reads current host paths again on every factory invocation", () => {
    captureRegistration();
    process.env.PI_PACKAGE_DIR = join(getDocsPath(), "reloaded pi package");
    documentationPathNames.forEach((name) => {
      process.env[name] = "/changed/after/initialization";
    });

    captureRegistration();

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    const expectedPaths = [getReadmePath(), getDocsPath(), getExamplesPath()];
    assert.deepEqual(actualPaths, expectedPaths);
  });

  it("respects PI_PACKAGE_DIR without requiring the assets to exist", () => {
    const tempRoot = "/tmp/work/dotfiles";
    mkdirSync(tempRoot, { recursive: true });
    const directory = mkdtempSync(join(tempRoot, "system-prompt-assets-"));
    const packageDirectory = join(directory, "missing pi package");
    try {
      process.env.PI_PACKAGE_DIR = packageDirectory;

      captureRegistration();

      const actualPaths = documentationPathNames.map((name) => process.env[name]);
      const expectedPaths = [
        join(packageDirectory, "README.md"),
        join(packageDirectory, "docs"),
        join(packageDirectory, "examples"),
      ];
      assert.deepEqual(actualPaths, expectedPaths);
      assert.equal(process.env.PI_PACKAGE_DIR, packageDirectory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the host API defaults for an empty PI_PACKAGE_DIR", () => {
    process.env.PI_PACKAGE_DIR = "";

    captureRegistration();

    const actualPaths = documentationPathNames.map((name) => process.env[name]);
    const expectedPaths = [getReadmePath(), getDocsPath(), getExamplesPath()];
    assert.deepEqual(actualPaths, expectedPaths);
    assert.equal(process.env.PI_PACKAGE_DIR, "");
  });
});

describe("non-forced runs on the installed ExtensionRunner", () => {
  it("replaces the head with a byte-identical build and forces nothing", async () => {
    const options = richOptions();
    const loaded = loadSystemPromptExtension();
    await emitSessionStart(loaded);
    const runner = runnerFor([loaded.extension]);
    const start = await runner.emitBeforeAgentStart("hello", undefined, options);
    // The extension must not introduce a forced prompt: dynamic per-turn
    // options keep flowing exactly as without it.
    assert.equal(start.systemPromptOptions.forceSystemPrompt, undefined);

    const result = await runner.emitContext(transcriptFor(options));
    const head = result[0] as SystemMessage;
    assert.equal(head.role, "system");
    assert.equal(head.sections, undefined);
    assert.equal(head.content, oracle.buildSystemPrompt(options));
    assert.equal(head.content, buildSystemPrompt(options));
  });

  it("preserves tool declarations and later messages as-is", async () => {
    const options = richOptions();
    const messages = transcriptFor(options);
    const loaded = loadSystemPromptExtension();
    await emitSessionStart(loaded);
    const runner = runnerFor([loaded.extension]);
    await runner.emitBeforeAgentStart("hello", undefined, options);

    const result = await runner.emitContext(messages);
    assert.equal(result.length, messages.length);
    const head = result[0] as SystemMessage;
    const originalHead = messages[0] as SystemMessage;
    assert.deepEqual(head.toolsAdded, originalHead.toolsAdded);
    // emitContext clones the input, so later messages survive structurally.
    assert.deepEqual(result[1], messages[1]);
  });

  it("adopts mid-run tool patches instead of reverting them", async () => {
    const options = richOptions();
    const grownOptions = {
      ...options,
      selectedTools: ["read", "edit", "bash"],
      toolSnippets: { ...options.toolSnippets, bash: "Execute commands" },
    };
    const messages: AgentMessage[] = [
      ...transcriptFor(options),
      {
        role: "system",
        content: "",
        // The patch Pi appends when the tool loadout grows before the request.
        sections: { tools: oracle.buildSystemPromptSections(grownOptions).tools },
        toolsAdded: [toolDeclaration("bash", "Execute commands")],
        timestamp: 3,
      },
    ];
    const loaded = loadSystemPromptExtension();
    await emitSessionStart(loaded);
    const runner = runnerFor([loaded.extension]);
    await runner.emitBeforeAgentStart("hello", undefined, options);

    const result = await runner.emitContext(messages);
    const head = result[0] as SystemMessage;
    const patchMessage = messages[2] as SystemMessage;
    // Expected: turn-one sections with only the tools section replaced by the patch.
    const expectedSections = {
      ...oracle.buildSystemPromptSections(options),
      tools: oracle.buildSystemPromptSections(grownOptions).tools,
    };
    assert.equal(head.content, Object.values(expectedSections).join("\n\n"));
    assert.match(head.content, /- bash: Execute commands/);
    // The patch message itself stays untouched in the list.
    assert.deepEqual((result[2] as SystemMessage).sections, patchMessage.sections);
    assert.deepEqual((result[2] as SystemMessage).toolsAdded, patchMessage.toolsAdded);
  });

  it("adopts sections owned by other extensions, including mid-run additions", async () => {
    const options = { ...richOptions(), sections: { extra_guidance: "EG" } };
    const messages: AgentMessage[] = [
      ...transcriptFor(options),
      {
        role: "system",
        content: "",
        sections: { mcp_servers: "<mcp_servers>\nconnected\n</mcp_servers>" },
        timestamp: 3,
      },
    ];
    const loaded = loadSystemPromptExtension();
    await emitSessionStart(loaded);
    const runner = runnerFor([loaded.extension]);
    await runner.emitBeforeAgentStart("hello", undefined, options);

    const result = await runner.emitContext(messages);
    const head = result[0] as SystemMessage;
    assert.match(head.content as string, /<extra_guidance>/);
    assert.match(head.content as string, /<mcp_servers>\nconnected\n<\/mcp_servers>/);
  });

  it("keeps a custom override of a built-in section owned by its extension", async () => {
    const options = { ...richOptions(), sections: { rules: "- custom rules" } };
    const loaded = loadSystemPromptExtension();
    await emitSessionStart(loaded);
    const runner = runnerFor([loaded.extension]);
    await runner.emitBeforeAgentStart("hello", undefined, options);

    const result = await runner.emitContext(transcriptFor(options));
    const head = result[0] as SystemMessage;
    assert.match(head.content as string, /- custom rules/);
    assert.doesNotMatch(head.content as string, /Be concise in your responses/);
  });

  it("does not touch messages before a run started or in forced runs", async () => {
    const options = richOptions();
    const messages = transcriptFor(options);

    // No before_agent_start yet (fresh session): nothing to build from, the
    // request is left alone.
    const cold = loadSystemPromptExtension();
    await emitSessionStart(cold);
    const coldResult = await runnerFor([cold.extension]).emitContext(messages);
    assert.deepEqual(coldResult, messages);

    // Forced run: the forced-prompt projection owns the request head.
    const forced = loadSystemPromptExtension();
    await emitSessionStart(forced);
    const forcedRunner = runnerFor([forcingExtension("\n\nAGENT"), forced.extension]);
    await forcedRunner.emitBeforeAgentStart("hello", undefined, options);
    const projected = await forcedRunner.emitContext(messages);
    assert.deepEqual(projected, messages);
  });

  it("keeps next-turn option updates visible (no force freeze)", async () => {
    const options = richOptions();
    const loaded = loadSystemPromptExtension();
    const runner = runnerFor([loaded.extension]);
    const start = await runner.emitBeforeAgentStart("hello", undefined, options);
    // Same re-normalization agent-session applies for the next turn.
    const nextTurn = oracle.normalizeBuildSystemPromptOptions({
      ...start.systemPromptOptions,
      selectedTools: ["read", "edit", "bash"],
      toolSnippets: { ...options.toolSnippets, bash: "Execute commands" },
    });
    assert.match(oracle.buildSystemPrompt(nextTurn), /- bash: Execute commands/);
  });
});

describe("forced runs with an earlier forcing extension", () => {
  const addendum = "\n\nAGENT ADDENDUM";

  async function forcedRun(options: BuildSystemPromptOptions): Promise<string | undefined> {
    const runner = runnerFor([forcingExtension(addendum), loadSystemPromptExtension().extension]);
    const start = await runner.emitBeforeAgentStart("hello", undefined, options);
    return start.systemPromptOptions.forceSystemPrompt;
  }

  it("replaces the standard prefix with its own build and keeps the suffix", async () => {
    const options = richOptions();
    const forced = await forcedRun(options);
    const own = buildSystemPrompt({ ...options, forceSystemPrompt: undefined });
    assert.equal(forced, own + addendum);
    assert.equal(forced, oracle.buildSystemPrompt(options) + addendum);
  });

  it("replaces the prefix for customPrompt runs as well", async () => {
    const options = { ...richOptions(), customPrompt: "You are a pirate." };
    const forced = await forcedRun(options);
    assert.equal(forced, buildSystemPrompt(options) + addendum);
    assert.equal(forced?.startsWith("You are a pirate."), true);
  });

  it("leaves an unrelated forced prompt untouched end to end", async () => {
    const options = richOptions();
    const runner = runnerFor([
      opaqueForcingExtension("completely different forced prompt"),
      loadSystemPromptExtension().extension,
    ]);
    const start = await runner.emitBeforeAgentStart("hello", undefined, options);
    assert.equal(start.systemPromptOptions.forceSystemPrompt, "completely different forced prompt");
  });

  it("returns nothing when the forced prompt does not start with its build", async () => {
    const handler = captureHandlers().get("before_agent_start")![0]!;
    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPromptOptions: {
          ...richOptions(),
          forceSystemPrompt: "completely different forced prompt",
        },
      },
      undefined,
    );
    assert.equal(result, undefined);
  });

  it("returns own build plus suffix on a direct prefix match", async () => {
    const handler = captureHandlers().get("before_agent_start")![0]!;
    const own = buildSystemPrompt(richOptions());
    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPromptOptions: { ...richOptions(), forceSystemPrompt: `${own} SUFFIX` },
      },
      undefined,
    );
    assert.deepEqual(result, { systemPrompt: `${own} SUFFIX` });
  });

  it("returns nothing when nothing is forced", async () => {
    const handler = captureHandlers().get("before_agent_start")![0]!;
    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPromptOptions: richOptions(),
      },
      undefined,
    );
    assert.equal(result, undefined);
  });
});

describe("foldSystemMessages and assembleHeadContent", () => {
  it("replays section patches including removals in first-seen order", () => {
    const folded = foldSystemMessages([
      {
        role: "system",
        content: "",
        sections: { preamble: "P", tools: "T1", gone: "G" },
        toolsAdded: [toolDeclaration("read", "R")],
        timestamp: 1,
      },
      { role: "user", content: "hi", timestamp: 2 },
      {
        role: "system",
        content: "",
        sections: { tools: "T2", gone: null, back: "B" },
        toolsAdded: [toolDeclaration("bash", "B")],
        timestamp: 3,
      },
      {
        role: "system",
        content: "",
        sections: {},
        toolsRemoved: [{ name: "edit" }],
        timestamp: 4,
      },
    ]);
    assert.deepEqual(
      [...folded.sections.entries()],
      [
        ["preamble", "P"],
        ["tools", "T2"],
        ["back", "B"],
      ],
    );
    assert.deepEqual(folded.activeToolNames, ["read", "bash"]);
  });

  it("prefers its own build over the folded text for known static sections", () => {
    const options = richOptions();
    const oracleSections: [string, string][] = Object.entries(
      oracle.buildSystemPromptSections(options) as Record<string, string>,
    );
    const folded: FoldedSystemState = {
      // A stale/different transcript text must not win over the
      // extension's own wording for sections it can build.
      sections: new Map([
        ["preamble", "different preamble from the transcript"],
        ...oracleSections.slice(1),
      ]),
      activeToolNames: options.selectedTools,
    };
    const assembled = assembleHeadContent(folded, "", options);
    const ownPreamble = buildSystemPromptSections(options).preamble ?? "";
    assert.match(assembled, new RegExp(`^${escapeRegExp(ownPreamble)}`));
    assert.equal(assembled.includes("different preamble from the transcript"), false);
  });

  it("keeps prior head content ahead of the sections", () => {
    const options = richOptions();
    const folded = foldSystemMessages(transcriptFor(options));
    const assembled = assembleHeadContent(folded, "existing head text", options);
    assert.match(assembled, /^existing head text\n\n/);
  });
});

describe("canonical template sections in assembleHeadContent", () => {
  const template: SystemPromptTemplate = {
    variables: { LANGUAGE: "ja" },
    sections: {
      preamble: "Custom preamble for {{CODING_AGENT}}.",
      "extra-guidance": "Always answer in {{LANGUAGE}}.",
    },
  };

  it("replaces template-owned sections and appends new ones", () => {
    const options = richOptions();
    const folded = foldSystemMessages(transcriptFor(options));
    const assembled = assembleHeadContent(folded, "", options, { template });
    assert.match(assembled, /^Custom preamble for pi\./);
    assert.match(assembled, /\n\n<extra-guidance>\nAlways answer in ja\.\n<\/extra-guidance>$/);
  });

  it("keeps template-owned rules even when the tool list changed mid-run", () => {
    const options = richOptions();
    const folded = foldSystemMessages(transcriptFor(options));
    // A mid-run tool change normally falls back to Pi-built text; the
    // template's explicit text must survive it.
    const changed: FoldedSystemState = { ...folded, activeToolNames: ["bash"] };
    const assembled = assembleHeadContent(changed, "", options, {
      template: { variables: {}, sections: { rules: "- canonical rule" } },
    });
    assert.match(assembled, /<rules>\n- canonical rule\n<\/rules>/);
  });

  it("renders a template skills section from the run's visible skills", () => {
    const options = richOptions();
    const folded = foldSystemMessages(transcriptFor(options));
    const assembled = assembleHeadContent(folded, "", options, {
      template: {
        variables: {},
        sections: { skills: { each: "- {{name}}: {{description}}" } },
      },
    });
    assert.match(assembled, /<skills>\n- coding: Coding standards\n<\/skills>/);
    assert.doesNotMatch(assembled, /<available_skills>/);
  });
});

describe("session_start indicator", () => {
  const plainViewerTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };

  /** Build the component the factory handed to ctx.ui.custom. */
  function viewerComponent(call: ViewerCustomCall): { render: (width: number) => string[] } {
    return call.factory(
      { terminal: { rows: 200, columns: 80 }, requestRender: () => {} },
      plainViewerTheme,
      undefined,
      () => {},
    );
  }

  /** Build the component the factory handed to ctx.ui.setWidget. */
  function widgetComponent(call: WidgetCall): {
    render: (width: number) => string[];
    handleMouse: (event: unknown) => unknown;
  } {
    const factory = call.content as (
      tui: unknown,
      theme: unknown,
    ) => { render: (width: number) => string[]; handleMouse: (event: unknown) => unknown };
    return factory(undefined, plainViewerTheme);
  }

  it("shows a collapsed indicator instead of opening the viewer", async () => {
    const prompt = buildSystemPrompt(richOptions());
    const loaded = loadSystemPromptExtension();
    const { ctx, customCalls, widgetCalls } = sessionStartCtx("tui", prompt);

    await dispatchSessionStart(loaded, ctx);
    // The full overlay never opens on its own.
    assert.equal(customCalls.length, 0);
    assert.equal(widgetCalls.length, 1);
    assert.equal(widgetCalls[0]!.key, "system-prompt");
    assert.equal(widgetCalls[0]!.options?.placement, "belowEditor");

    const rendered = widgetComponent(widgetCalls[0]!).render(80) as string[];
    assert.equal(rendered.length, 1);
    assert.equal(
      rendered[0],
      `📜 system prompt: ${prompt.length} chars / ${prompt.split("\n").length} lines / click to view`,
    );
    // The collapsed line carries a summary, never the prompt itself.
    assert.equal(rendered[0]!.includes(prompt), false);
  });

  it("expands into the full prompt overlay when the indicator is activated", async () => {
    const prompt = buildSystemPrompt(richOptions());
    const loaded = loadSystemPromptExtension();
    const { ctx, customCalls, widgetCalls } = sessionStartCtx("tui", prompt);
    await dispatchSessionStart(loaded, ctx);

    widgetComponent(widgetCalls[0]!).handleMouse({
      type: "click",
      button: "left",
    });
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options?.overlay, true);
    const rendered = viewerComponent(customCalls[0]!).render(80);
    const expected = new Text(prompt, 1, 0).render(80);
    assert.deepEqual(rendered.slice(2, -1), expected);
    assert.equal(rendered[0], "System prompt");
  });

  it("shows nothing when the session has no terminal UI", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const loaded = loadSystemPromptExtension();
      const { ctx, customCalls, widgetCalls } = sessionStartCtx(
        mode,
        buildSystemPrompt(richOptions()),
      );
      await dispatchSessionStart(loaded, ctx);
      assert.equal(widgetCalls.length, 0);
      assert.equal(customCalls.length, 0);
    }
  });

  it("coexists with the run-state reset in the same session_start", async () => {
    const options = richOptions();
    const loaded = loadSystemPromptExtension();
    const runner = runnerFor([loaded.extension]);
    // Establish run state, then start a session with a tui context.
    await runner.emitBeforeAgentStart("hello", undefined, options);
    const { ctx, customCalls, widgetCalls } = sessionStartCtx("tui", buildSystemPrompt(options));
    await dispatchSessionStart(loaded, ctx);

    // The indicator was requested...
    assert.equal(widgetCalls.length, 1);
    assert.equal(customCalls.length, 0);
    // ...and the reset still happened: context_with_system leaves the
    // messages alone until the next run captures fresh options.
    const messages = transcriptFor(options);
    const result = await runner.emitContext(messages);
    assert.deepEqual(result, messages);
  });
});

describe("intentional viewer triggers", () => {
  it("registers the ctrl+shift+p shortcut and the /system-prompt command", () => {
    const { shortcuts, commands } = captureRegistration();
    assert.deepEqual(
      shortcuts.map((shortcut) => shortcut.key),
      ["ctrl+shift+p"],
    );
    assert.deepEqual(
      commands.map((command) => command.name),
      ["system-prompt"],
    );
  });

  it("opens the overlay viewer from the shortcut handler in tui mode", async () => {
    const prompt = buildSystemPrompt(richOptions());
    const { shortcuts } = captureRegistration();
    const { ctx, customCalls } = sessionStartCtx("tui", prompt);

    // Shortcut handlers receive only the extension context.
    await shortcuts[0]!.options.handler(ctx);
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options?.overlay, true);
  });

  it("opens the overlay viewer from the command handler in tui mode", async () => {
    const prompt = buildSystemPrompt(richOptions());
    const { commands } = captureRegistration();
    const { ctx, customCalls } = sessionStartCtx("tui", prompt);

    await commands[0]!.options.handler("", ctx);
    assert.equal(customCalls.length, 1);
    assert.equal(customCalls[0]!.options?.overlay, true);
  });

  it("does nothing outside tui mode from the registered triggers", async () => {
    const { shortcuts, commands } = captureRegistration();
    for (const mode of ["rpc", "json", "print"] as const) {
      const shortcutCtx = sessionStartCtx(mode, buildSystemPrompt(richOptions()));
      await shortcuts[0]!.options.handler(shortcutCtx.ctx);
      assert.equal(shortcutCtx.customCalls.length, 0);

      const commandCtx = sessionStartCtx(mode, buildSystemPrompt(richOptions()));
      await commands[0]!.options.handler("", commandCtx.ctx);
      assert.equal(commandCtx.customCalls.length, 0);
    }
  });
});

describe("canonical template file", () => {
  /** The repo's canonical SYSTEM_PROMPT.yaml: four levels up is dotfiles/. */
  function canonicalTemplate(): SystemPromptTemplate {
    const canonicalPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../.agents/SYSTEM_PROMPT.yaml",
    );
    return parseSystemPromptTemplate(readFileSync(canonicalPath, "utf8"));
  }

  it("renders the canonical wording without docs across the standard option sets", () => {
    const template = canonicalTemplate();
    const optionSets: BuildSystemPromptOptions[] = [
      richOptions(),
      { cwd: "/w" },
      { cwd: "/w", selectedTools: ["bash", "powershell"] },
      { cwd: "C:\\Users\\user\\project" },
      {
        ...richOptions(),
        selectedTools: ["bash"],
        toolSnippets: { ...richOptions().toolSnippets, bash: "Execute commands" },
      },
      {
        ...richOptions(),
        appendSystemPrompt: "",
        contextFiles: [
          { path: "a.md", content: "a & b < c > \"d\" 'e'" },
          { path: "sub/b.md", content: "line1\n\nline2" },
        ],
        skills: [
          {
            name: "code & review",
            description: "Standards <tags> \"quoted\" 'apos'",
            filePath: "/skills/code & review/SKILL.md",
            baseDir: "/skills/code & review",
            sourceInfo: {} as never,
            disableModelInvocation: false,
          },
        ],
      },
    ];
    for (const raw of optionSets) {
      const options = normalizeBuildSystemPromptOptions(raw);
      const assembled = assembleHeadContent(
        foldSystemMessages(transcriptFor(options)),
        "",
        options,
        { template },
      );
      const expectedSections: Record<string, string> = {
        ...oracle.buildSystemPromptSections(options),
        preamble:
          "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
      };
      delete expectedSections.docs;
      expectedSections.tools = expectedSections.tools!.replace(
        "In addition to the tools above, you may have access to other custom tools depending on the project.",
        "Additional tools may be available.",
      );
      if (expectedSections.skills !== undefined) {
        expectedSections.skills = expectedSections.skills.replace(
          "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
          "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
        );
      }
      assert.equal(assembled, Object.values(expectedSections).join("\n\n"));
      assert.doesNotMatch(assembled, /<\/?docs>/);
    }
  });

  it("keeps template list sections fresh across a mid-run tool change", () => {
    const options = richOptions();
    const grownOptions = {
      ...options,
      selectedTools: ["read", "edit", "bash"],
      toolSnippets: { ...options.toolSnippets, bash: "Execute commands" },
    };
    const changed: FoldedSystemState = {
      ...foldSystemMessages(transcriptFor(options)),
      activeToolNames: grownOptions.selectedTools,
    };
    const assembled = assembleHeadContent(changed, "", grownOptions, {
      template: canonicalTemplate(),
    });
    assert.match(
      assembled,
      /<tools>\n- read: Read files\n- edit: Edit files\n- bash: Execute commands\n\nAdditional tools may be available\./,
    );
  });

  it("defines the six required sections without a docs section", () => {
    const names = Object.keys(canonicalTemplate().sections).sort();
    const expectedNames = ["preamble", "tools", "rules", "skills", "cwd", "project_context"].sort();
    assert.deepEqual(names, expectedNames);
  });

  it("drops template-owned project_context when no context files exist", () => {
    const options = { ...richOptions(), contextFiles: [] };
    const folded = foldSystemMessages(transcriptFor(options));
    const assembled = assembleHeadContent(folded, "", options, { template: canonicalTemplate() });
    assert.equal(assembled.includes("<project_context>"), false);
  });
});

describe("optional docs in a loaded canonical template", () => {
  const sections = {
    preamble: "Canonical preamble",
    tools: "Canonical tools",
    rules: "Canonical rules",
    skills: "Canonical skills",
    cwd: "{{CWD}}",
    project_context: "Canonical context",
  };
  const withoutDocs = YAML.stringify({ sections });

  async function withTemplateFile(
    raw: string | undefined,
    check: (loaded: LoadedExtension, warnings: string[]) => Promise<void>,
  ): Promise<void> {
    const tempRoot = "/tmp/work/dotfiles";
    mkdirSync(tempRoot, { recursive: true });
    const directory = mkdtempSync(join(tempRoot, "system-prompt-"));
    const path = join(directory, "SYSTEM_PROMPT.yaml");
    try {
      if (raw !== undefined) writeFileSync(path, raw);
      const loaded = loadSystemPromptExtension(() => path);
      const warnings: string[] = [];
      const { ctx } = sessionStartCtx("print");
      await dispatchSessionStart(loaded, {
        ...ctx,
        hasUI: true,
        ui: { ...ctx.ui, notify: (message: string) => warnings.push(message) },
      });
      await check(loaded, warnings);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async function renderTemplateRun(
    loaded: LoadedExtension,
    options: NormalizedBuildSystemPromptOptions,
    messages = transcriptFor(options),
  ): Promise<SystemMessage> {
    await loaded.handlers.get("before_agent_start")![0]!({ systemPromptOptions: options }, {});
    const result = (await loaded.handlers.get("context_with_system")![0]!({ messages }, {})) as {
      messages: AgentMessage[];
    };
    return result.messages[0] as SystemMessage;
  }

  it("omits standard docs text and tags without warning or fallback", async () => {
    await withTemplateFile(withoutDocs, async (loaded, warnings) => {
      const head = await renderTemplateRun(loaded, richOptions());
      assert.match(head.content as string, /^Canonical preamble/);
      assert.doesNotMatch(head.content as string, /<\/?docs>|Pi documentation/);
      assert.deepEqual(warnings, []);
    });
  });

  for (const docs of ["Custom documentation", ""]) {
    it(`renders an explicit docs string including empty tags: ${JSON.stringify(docs)}`, async () => {
      await withTemplateFile(
        YAML.stringify({ sections: { ...sections, docs } }),
        async (loaded) => {
          const options = { ...richOptions(), sections: { docs: "Other extension docs" } };
          const head = await renderTemplateRun(loaded, options);
          const expectedDocs = `<docs>\n${docs}\n</docs>`;
          assert.ok((head.content as string).includes(expectedDocs));
          assert.doesNotMatch(head.content as string, /Other extension docs|Pi documentation/);
        },
      );
    });
  }

  it("keeps sections and addenda owned by other extensions when docs is omitted", async () => {
    await withTemplateFile(withoutDocs, async (loaded) => {
      const options = {
        ...richOptions(),
        sections: { docs: "Other extension docs", extra_guidance: "Extra guidance" },
      };
      const messages: AgentMessage[] = [
        ...transcriptFor(options),
        {
          role: "system",
          content: "",
          sections: { mcp_servers: "<mcp_servers>\nconnected\n</mcp_servers>" },
          timestamp: 3,
        },
      ];
      const head = await renderTemplateRun(loaded, options, messages);
      assert.match(head.content as string, /<docs>\nOther extension docs\n<\/docs>/);
      assert.match(head.content as string, /<extra_guidance>\nExtra guidance\n<\/extra_guidance>/);
      assert.match(head.content as string, /<mcp_servers>\nconnected\n<\/mcp_servers>/);
      assert.match(head.content as string, /<addendum>\nStanding addendum\.\n<\/addendum>/);
    });
  });

  const { tools: _tools, ...missingTools } = sections;
  const fallbackCases = [
    { name: "missing template", raw: undefined },
    { name: "invalid YAML", raw: "sections: [" },
    { name: "invalid docs type", raw: YAML.stringify({ sections: { ...sections, docs: false } }) },
    { name: "missing required section", raw: YAML.stringify({ sections: missingTools }) },
  ];
  for (const { name, raw } of fallbackCases) {
    it(`keeps the standard fallback including docs for a ${name}`, async () => {
      await withTemplateFile(raw, async (loaded, warnings) => {
        const options = richOptions();
        const head = await renderTemplateRun(loaded, options);
        assert.equal(head.content, buildSystemPrompt(options));
        assert.match(head.content as string, /<docs>\nPi documentation/);
        assert.equal(warnings.length, raw === undefined ? 0 : 1);
        if (raw !== undefined) assert.match(warnings[0]!, /^Ignoring .*SYSTEM_PROMPT\.yaml:/);
      });
    });
  }

  it("keeps a matching forced prefix without docs and preserves the full suffix", async () => {
    await withTemplateFile(withoutDocs, async (loaded) => {
      const options = richOptions();
      const own = assembleHeadContent(foldSystemMessages(transcriptFor(options)), "", options, {
        template: parseSystemPromptTemplate(withoutDocs),
      });
      const suffix = "\n\n<docs>\nOther extension suffix\n</docs>";
      const forced = own + suffix;
      const result = await loaded.handlers.get("before_agent_start")![0]!(
        { systemPromptOptions: { ...options, forceSystemPrompt: forced } },
        {},
      );
      assert.doesNotMatch(own, /<\/?docs>|Pi documentation/);
      assert.deepEqual(result, { systemPrompt: forced });
    });
  });

  it("leaves a mismatching forced standard prompt including docs untouched", async () => {
    await withTemplateFile(withoutDocs, async (loaded) => {
      const forced = buildSystemPrompt(richOptions()) + "\n\nOther extension suffix";
      const options = { ...richOptions(), forceSystemPrompt: forced };
      const result = await loaded.handlers.get("before_agent_start")![0]!(
        { systemPromptOptions: options },
        {},
      );
      assert.equal(result, undefined);
      assert.equal(options.forceSystemPrompt, forced);
      assert.match(options.forceSystemPrompt, /<docs>\nPi documentation/);
    });
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
