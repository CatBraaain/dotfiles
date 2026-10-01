import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "bun:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentToolResult,
  type CodemodeToolDetails,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
  type InlineExtension,
  type ModelRuntime,
  type Theme,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import sandboxedToolsExtension from "./index.ts";

initTheme("dark", false);

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const builtinCodemode: InlineExtension = {
  name: "codemode",
  builtin: true,
  replaceable: true,
  factory: createCodemodeExtension(),
};
const emptyModelRuntime = {
  getAvailableSnapshot: () => [],
  getModels: () => [],
  getModelsOfType: () => [],
  getError: () => undefined,
  streamSimple: () => {
    throw new Error("Model requests are forbidden in this test");
  },
} as unknown as ModelRuntime;

function withTemporarySession(
  test: (directory: string, sessions: AgentSession[]) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "codemode-session-"));
    const sessions: AgentSession[] = [];
    try {
      await test(directory, sessions);
    } finally {
      for (const session of sessions) session.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function resourceLoader(
  directory: string,
  settingsManager: SettingsManager,
  extensionFactories: InlineExtension[] = [builtinCodemode],
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

async function createSession(
  directory: string,
  settingsManager: SettingsManager,
  loader: DefaultResourceLoader,
  sessions: AgentSession[],
): Promise<AgentSession> {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    modelRuntime: emptyModelRuntime,
    noTools: "builtin",
  });
  sessions.push(session);
  await session.bindExtensions({});
  assert.deepEqual(session.modelRuntime.getAvailableSnapshot(), []);
  return session;
}

function renderLines(definition: ToolDefinition, result: AgentToolResult<unknown>): string[] {
  return definition.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, {
    args: { code: "return 1;" },
    toolCallId: "script",
    invalidate: () => {},
    state: {},
    lastComponent: undefined,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  })
    .render(200)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

async function executeScript(
  session: AgentSession,
  code: string,
): Promise<AgentToolResult<CodemodeToolDetails>> {
  const toolCall = {
    type: "toolCall" as const,
    id: "script",
    name: "codemode",
    arguments: { code },
  };
  session.agent.state.messages = [
    {
      role: "assistant",
      content: [toolCall],
      api: "openai-completions",
      provider: "test",
      model: "no-model-request",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    },
  ];
  const tool = session.agent.state.tools.find((candidate) => candidate.name === "codemode");
  assert.ok(tool);
  return tool.execute(toolCall.id, toolCall.arguments) as Promise<
    AgentToolResult<CodemodeToolDetails>
  >;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function sandboxSession(
  directory: string,
  sessions: AgentSession[],
  observer: ExtensionFactory,
): Promise<AgentSession> {
  const configPath = join(directory, "sandbox.yaml");
  writeFileSync(
    configPath,
    `read:\n  - deny: ${directory}/denied\nwrite:\n  - ask: ${directory}/requested\ncommands:\n  - deny: '^forbidden-command$'\n  - ask_with_reason: '^reason-command$'\n`,
  );
  const settingsManager = SettingsManager.inMemory({ codemode: { mode: "on" } });
  const loader = resourceLoader(directory, settingsManager, [
    builtinCodemode,
    { name: "sandboxed-tools", factory: (pi) => sandboxedToolsExtension(pi, configPath) },
    observer,
  ]);
  const session = await createSession(directory, settingsManager, loader, sessions);
  session.setActiveToolsByName([
    "codemode",
    "read",
    "write",
    "bash",
    "ask_permission",
    "safe_probe",
  ]);
  return session;
}

function observeNestedCalls(
  calls: ToolCallEvent[],
  results: ToolResultEvent[],
  executions: string[],
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "safe_probe",
      label: "Safe probe",
      description: "In-memory probe for nested hooks",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_id, { value }) => {
        executions.push(value);
        return { content: [{ type: "text", text: `executed:${value}` }], details: {} };
      },
    });
    pi.on("tool_call", (event) => {
      calls.push(structuredClone(event));
      if (event.toolName === "safe_probe" && event.input.value === "blocked") {
        return { block: true, reason: "blocked by test hook" };
      }
    });
    pi.on("tool_result", (event) => {
      results.push(structuredClone(event));
      if (event.toolName === "safe_probe" && !event.isError) {
        return { content: [{ type: "text", text: "changed by result hook" }] };
      }
    });
  };
}

describe("codemode resource ownership through the standard loader", () => {
  it(
    "switches shortened and standard renderers when sandboxed-tools is enabled, disabled, and reloaded",
    withTemporarySession(async (directory, sessions) => {
      const extensionDirectory = join(directory, "agent", "extensions", "sandboxed-tools");
      mkdirSync(join(directory, "agent", "extensions"), { recursive: true });
      symlinkSync(import.meta.dir, extensionDirectory, "dir");
      const extensionPath = join(extensionDirectory, "index.ts");
      const settingsManager = SettingsManager.inMemory({ codemode: { mode: "on" } });
      const loader = resourceLoader(directory, settingsManager);
      const session = await createSession(directory, settingsManager, loader, sessions);
      const result: AgentToolResult<CodemodeToolDetails> = {
        content: [
          { type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
          { type: "text", text: "body" },
        ],
        details: { calls: [{ id: "script/1", name: "read", args: "file", status: "ok" }] },
      };
      for (const [loadIndex, enabled] of [true, false, true].entries()) {
        if (loadIndex > 0) {
          settingsManager.setExtensionPaths(enabled ? [] : [`-${extensionPath}`]);
          await session.reload();
        }
        assert.deepEqual(loader.getExtensions().errors, []);
        const owners = loader
          .getExtensions()
          .extensions.filter((extension) => extension.tools.has("codemode"));
        assert.equal(owners.length, 1);
        assert.equal(owners[0]!.path, enabled ? extensionPath : "builtin:codemode");
        const definition = session.getToolDefinition("codemode")!;
        assert.equal(definition.defaultActive, false);
        assert.equal(definition.exposure, "model-only");
        session.setActiveToolsByName(["codemode"]);
        assert.ok(session.getActiveToolNames().includes("codemode"));
        const lines = renderLines(definition, result);
        if (enabled) {
          assert.equal(lines[0], "1.2s");
          assert.doesNotMatch(lines.join("\n"), /read file/);
        } else {
          assert.match(lines.join("\n"), /read file/);
          assert.doesNotMatch(lines.join("\n"), /^1\.2s/m);
        }
        assert.match(lines.join("\n"), /body/);
      }
    }),
  );
});

describe("codemode nested AgentSession pipeline without a model request", () => {
  it(
    "runs before and after hooks with parent IDs and returns the after-hook content to the script",
    withTemporarySession(async (directory, sessions) => {
      const calls: ToolCallEvent[] = [];
      const results: ToolResultEvent[] = [];
      const executions: string[] = [];
      const session = await sandboxSession(
        directory,
        sessions,
        observeNestedCalls(calls, results, executions),
      );
      const result = await executeScript(
        session,
        'text(await tools.safe_probe({value:"allowed"}));',
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(executions, ["allowed"]);
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(calls[0]!.toolName, "safe_probe");
      assert.equal(calls[0]!.parentToolCallId, "script");
      assert.deepEqual(calls[0]!.input, { value: "allowed" });
      assert.equal(results[0]!.parentToolCallId, "script");
      assert.equal(results[0]!.toolCallId, calls[0]!.toolCallId);
      assert.deepEqual(results[0]!.content, [{ type: "text", text: "executed:allowed" }]);
      assert.equal(results[0]!.isError, false);
      assert.match(resultText(result), /changed by result hook/);
      assert.equal(result.details.calls[0]!.status, "ok");
      assert.equal(session.agent.state.messages.length, 1);
      assert.equal(
        session.sessionManager.getBranch().some((entry) => entry.type === "message"),
        false,
      );
    }),
  );

  it(
    "blocks a nested call in the before hook without executing it and preserves its error trace",
    withTemporarySession(async (directory, sessions) => {
      const calls: ToolCallEvent[] = [];
      const results: ToolResultEvent[] = [];
      const executions: string[] = [];
      const session = await sandboxSession(
        directory,
        sessions,
        observeNestedCalls(calls, results, executions),
      );
      const result = await executeScript(
        session,
        'try { await tools.safe_probe({value:"blocked"}); } catch (error) { text(error.message); }',
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(executions, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.parentToolCallId, "script");
      assert.deepEqual(results, []);
      assert.match(resultText(result), /blocked by test hook/);
      assert.equal(result.details.calls[0]!.status, "error");
      assert.deepEqual(
        renderLines(session.getToolDefinition("codemode")!, result),
        renderLines(createStandardDefinition(), result),
      );
    }),
  );

  for (const scenario of [
    {
      name: "read",
      args: (directory: string) => ({ path: join(directory, "denied", "file.txt") }),
      diagnostic: "Access denied:",
    },
    {
      name: "write",
      args: (directory: string) => ({
        path: join(directory, "requested", "file.txt"),
        content: "must not be written",
      }),
      diagnostic: "Access requires confirmation:",
    },
    { name: "bash", args: () => ({ command: "forbidden-command" }), diagnostic: "Command denied:" },
    {
      name: "bash",
      args: () => ({ command: "reason-command" }),
      diagnostic: "Command requires a reason:",
    },
    {
      name: "ask_permission",
      args: (directory: string) => ({
        path: join(directory, "requested"),
        reason: "test permission boundary",
      }),
      diagnostic: "Access requires confirmation:",
    },
  ]) {
    it(
      `reaches sandboxed ${scenario.name} authorization and reports ${scenario.diagnostic} through session hooks`,
      withTemporarySession(async (directory, sessions) => {
        const calls: ToolCallEvent[] = [];
        const results: ToolResultEvent[] = [];
        const executions: string[] = [];
        const session = await sandboxSession(
          directory,
          sessions,
          observeNestedCalls(calls, results, executions),
        );
        const args = scenario.args(directory);
        const result = await executeScript(
          session,
          `try { await tools.${scenario.name}(${JSON.stringify(args)}); } catch (error) { text(error.message); }`,
        );
        assert.equal(result.isError, undefined);
        assert.equal(calls.length, 1);
        assert.equal(results.length, 1);
        assert.equal(calls[0]!.toolName, scenario.name);
        assert.deepEqual(calls[0]!.input, args);
        assert.equal(calls[0]!.parentToolCallId, "script");
        assert.equal(results[0]!.parentToolCallId, "script");
        assert.equal(results[0]!.toolCallId, calls[0]!.toolCallId);
        assert.equal(results[0]!.isError, true);
        assert.ok(
          results[0]!.content.some(
            (block) => block.type === "text" && block.text.includes(scenario.diagnostic),
          ),
        );
        assert.ok(resultText(result).includes(scenario.diagnostic));
        assert.equal(result.details.calls[0]!.status, "error");
        assert.deepEqual(executions, []);
        assert.equal(existsSync(join(directory, "requested", "file.txt")), false);
      }),
    );
  }
  for (const target of ["path", "command"] as const) {
    it(
      `requests nested ${target} permission through the session UI boundary and returns denial without a grant`,
      withTemporarySession(async (directory, sessions) => {
        const calls: ToolCallEvent[] = [];
        const results: ToolResultEvent[] = [];
        const executions: string[] = [];
        const prompts: { title: string; options: string[] }[] = [];
        const session = await sandboxSession(
          directory,
          sessions,
          observeNestedCalls(calls, results, executions),
        );
        const deniedUI = {
          select: async (title: string, options: string[]) => {
            prompts.push({ title, options });
            return undefined;
          },
          input: async () => "fixture denial",
          notify: () => {},
        } as unknown as ExtensionUIContext;
        await session.bindExtensions({ uiContext: deniedUI });
        const requestedTarget = target === "path" ? join(directory, "requested") : "reason-command";
        const args = { [target]: requestedTarget, reason: "fixture permission reason" };
        const result = await executeScript(
          session,
          `text(await tools.ask_permission(${JSON.stringify(args)}));`,
        );
        assert.equal(result.isError, undefined);
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0]!.title.includes(requestedTarget));
        assert.match(prompts[0]!.title, /fixture permission reason/);
        assert.ok(prompts[0]!.options.some((option) => option.startsWith("No, deny")));
        assert.equal(calls.length, 1);
        assert.equal(results.length, 1);
        assert.equal(calls[0]!.parentToolCallId, "script");
        assert.equal(results[0]!.parentToolCallId, "script");
        assert.equal(results[0]!.isError, false);
        assert.equal((results[0]!.details as { status: string }).status, "denied");
        assert.match(resultText(result), /User denied[\s\S]*fixture denial/);
        assert.equal(result.details.calls[0]!.status, "ok");
        assert.deepEqual(executions, []);
        assert.equal(existsSync(join(directory, "requested")), false);
      }),
    );
  }
});

function createStandardDefinition(): ToolDefinition {
  let definition: ToolDefinition | undefined;
  createCodemodeExtension()({
    registerTool: (tool) => {
      definition = tool as ToolDefinition;
    },
  } as ExtensionAPI);
  assert.ok(definition);
  return definition;
}
