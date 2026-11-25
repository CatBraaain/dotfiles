import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "bun:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentsExtension from "../agents/index.ts";
import { fakeProvider, memoryRuntime } from "../recontext/test-fixture.ts";
import systemPromptExtension from "./index.ts";

const TEST_PROMPT_TEMPLATE =
  "sections:\n  preamble: Custom instructions.\n  tools: Custom tools.\n  rules: Custom rules.\n  cwd: '{{CWD}}'\n  project_context: Test context.\n  skills: Test skills.\n";

it("records the template and agent switches as native system-message differences", async () => {
  const root = "/tmp/work/dotfiles";
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "prompt-history-"));
  const template = join(directory, "SYSTEM_PROMPT.yaml");
  writeFileSync(template, TEST_PROMPT_TEMPLATE);
  try {
    const manager = SessionManager.create(directory, join(directory, "sessions"));
    const savedSystemMessages = () =>
      SessionManager.open(manager.getSessionFile()!)
        .getBranch()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
        );
    let savedAtProvider: string | undefined;
    const runtime = await memoryRuntime();
    const fake = fakeProvider("prompt-history");
    runtime.registerNativeProvider(fake.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel(fake.provider.id, "physical")!;
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      enableInstallTelemetry: false,
      defaultTools: [],
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) =>
          agentsExtension(
            pi,
            {
              config: {
                default: "main",
                defaultMode: "standard",
                modes: { standard: { middle: [{ provider: model.provider, model: model.id }] } },
                agents: {
                  main: {
                    class: "middle",
                    tools: [],
                    subagents: [],
                    systemPrompt: ["Main instructions."],
                  },
                  senior: {
                    class: "middle",
                    tools: [],
                    subagents: [],
                    systemPrompt: ["Senior instructions."],
                  },
                  plain: { class: "middle", tools: [], subagents: [], systemPrompt: [] },
                },
              },
            },
            async () => ({ exitCode: 127, stdout: "" }),
          ),
        (pi) => systemPromptExtension(pi, { templatePath: () => template }),
        (pi) => {
          pi.on("before_provider_request", () => {
            savedAtProvider = getCurrentSystemPrompt(savedSystemMessages());
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      settingsManager: settings,
      sessionManager: manager,
      resourceLoader: loader,
      tools: [],
    });
    try {
      const errors: unknown[] = [];
      await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
      const context = session.extensionRunner.createCommandContext();
      const switchAgent = (agent: string) =>
        session.extensionRunner.getCommand(`agent:${agent}`)!.handler("", context);
      const sendTurn = async () => {
        savedAtProvider = undefined;
        const requestCount = fake.state.requests.length;
        await session.prompt("Test prompt.");
        const request = fake.state.requests[requestCount];
        assert.ok(request, "Expected a request to the synthetic provider");
        const sent = getCurrentSystemPrompt(request.context.messages);
        assert.equal(sent, savedAtProvider);
        assert.equal(sent, getCurrentSystemPrompt(savedSystemMessages()));
        return sent;
      };

      const initial = await sendTurn();
      assert.match(initial, /^Custom instructions\./);
      assert.match(initial, /Main instructions\./);
      assert.doesNotMatch(initial, /<docs>/);
      assert.equal(savedSystemMessages().length, 1);
      const initialSystemMessage = savedSystemMessages()[0];

      await switchAgent("senior");
      assert.equal(savedSystemMessages().length, 1);
      const updated = await sendTurn();
      assert.match(updated, /Senior instructions\./);
      assert.doesNotMatch(updated, /Main instructions\./);
      assert.deepEqual(savedSystemMessages()[1]?.sections, {
        agent_instructions: "<agent_instructions>\nSenior instructions.\n</agent_instructions>",
      });

      assert.equal(await sendTurn(), updated);
      assert.equal(savedSystemMessages().length, 2);

      await switchAgent("plain");
      assert.doesNotMatch(await sendTurn(), /agent_instructions/);
      assert.deepEqual(savedSystemMessages()[2]?.sections, { agent_instructions: null });
      assert.deepEqual(savedSystemMessages()[0], initialSystemMessage);
      assert.deepEqual(errors, []);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
