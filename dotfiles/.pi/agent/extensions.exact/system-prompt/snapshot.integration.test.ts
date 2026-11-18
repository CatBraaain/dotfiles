import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { describe, it } from "bun:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fakeProvider, memoryRuntime } from "../recontext/test-fixture.ts";
import systemPromptExtension from "./index.ts";

type ForceMode = "normal" | "matching" | "opaque" | "later";

async function fixture(force: ForceMode) {
  const root = "/tmp/work/dotfiles";
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(`${root}/payload-integration-`);
  const manager = SessionManager.inMemory(directory);
  const runtime = await memoryRuntime();
  const fake = fakeProvider("prompt-payload");
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
  const payloads: unknown[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const path = `/tmp/${manager.getSessionId()}_system_prompt.md`;
  const opened: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Original instructions.",
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_request", () => {
          const request = fake.state.requests.at(-1)!;
          const payload = {
            instructions: getCurrentSystemPrompt(request.context.messages),
            input: [],
          };
          payloads.push(payload);
          return payload;
        });
        if (force === "matching" || force === "opaque") {
          pi.on("before_agent_start", (event) => ({
            systemPrompt:
              force === "matching" ? `${event.systemPrompt}\n\nFORCED SUFFIX` : "OPAQUE FORCED",
          }));
        }
      },
      (pi) => {
        const extensionApi = Object.assign(Object.create(pi), {
          exec: async () => {
            opened.push(readFileSync(path, "utf8"));
            return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
          },
        });
        systemPromptExtension(extensionApi, {
          templatePath: () => `${directory}/missing-template.yaml`,
        });
      },
      (pi) => {
        pi.on("context_with_system", (event) => ({
          messages: event.messages.map((message, index) =>
            index === 0 && message.role === "system"
              ? { ...message, content: "LATER CONTEXT REPLACEMENT", sections: undefined }
              : message,
          ),
        }));
        if (force === "later")
          pi.on("before_agent_start", () => ({ systemPrompt: "LATER FORCED" }));
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
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message) => notices.push(message),
    },
    onError: (error) => errors.push(error),
  });
  const context = session.extensionRunner.createCommandContext();
  async function open() {
    const command = session.extensionRunner.getCommand("view-system-prompt")!;
    await command.handler("", context);
  }
  function close() {
    session.dispose();
    rmSync(path, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
  return { session, fake, opened, payloads, notices, errors, open, close };
}

describe("payload capture through the installed AgentSession and ExtensionRunner", () => {
  for (const force of ["normal", "matching", "opaque", "later"] as const) {
    it(`captures the actual provider context after later context and force handlers: ${force}`, async () => {
      const test = await fixture(force);
      try {
        await test.open();
        assert.match(test.notices.pop()!, /No system prompt has been sent/);
        await test.session.prompt("Inspect the payload.");
        await test.open();
        const actualContext = test.fake.state.requests.at(-1)!.context;
        const actualPrompt = getCurrentSystemPrompt(actualContext.messages);
        assert.deepEqual(test.opened, [actualPrompt]);
        assert.deepEqual(test.payloads, [{ instructions: actualPrompt, input: [] }]);
        if (force === "normal") assert.equal(actualPrompt, "LATER CONTEXT REPLACEMENT");
        if (force === "matching") {
          assert.match(actualPrompt, /FORCED SUFFIX$/);
          assert.doesNotMatch(actualPrompt, /LATER CONTEXT REPLACEMENT/);
        }
        if (force === "opaque") assert.equal(actualPrompt, "OPAQUE FORCED");
        if (force === "later") assert.equal(actualPrompt, "LATER FORCED");
        assert.deepEqual(test.errors, []);
        assert.deepEqual(test.notices, []);
      } finally {
        test.close();
      }
    });
  }
});
