import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { Container } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import agentsExtension, { __spawn, __fs, __resetRoutingState } from "../agents/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  createAgentSession,
  initTheme,
  AssistantMessageComponent,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import streamRepetitionGuard from "./index.ts";

type FakeStream = ReturnType<NonNullable<ProviderConfig["streamSimple"]>>;
type AssistantMessage = Awaited<ReturnType<FakeStream["result"]>>;

describe("real SDK session with a free in-process provider", () => {
  for (const mode of ["json", "tui"] as const) {
    for (const raceDone of [false, true]) {
      it(`persists and publishes aborted reason without tool execution or retry (${mode}, ${raceDone ? "normal done race" : "cooperative abort"})`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-repetition-test-"));
        let requests = 0;
        let executions = 0;
        let streamSignal: AbortSignal | undefined;
        let ordinaryNextRun = false;
        let queued = false;
        let tui: any;
        let finalMessage: AssistantMessage | undefined;
        const provider: ProviderConfig = {
          api: "repetition-test",
          apiKey: "test-only-no-network",
          baseUrl: "http://unused.invalid",
          models: [
            {
              id: "free",
              name: "Free fake",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 10000,
            },
          ],
          streamSimple: (model, _context, options) => {
            requests++;
            streamSignal = options?.signal;
            const message: AssistantMessage = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: requests,
              content: [],
              stopReason: "toolUse",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            let resolveResult!: (message: AssistantMessage) => void;
            const result = new Promise<AssistantMessage>((resolve) => {
              resolveResult = resolve;
            });
            return {
              result: () => result,
              async *[Symbol.asyncIterator]() {
                await options?.onPayload?.({}, model);
                await options?.onResponse?.({ status: 200, headers: {} }, model);
                yield { type: "start", partial: message };
                if (ordinaryNextRun) {
                  message.content.push({ type: "text", text: "ordinary response" });
                  yield {
                    type: "text_delta",
                    delta: "ordinary response",
                    contentIndex: 0,
                    partial: message,
                  };
                  message.stopReason = "stop";
                  resolveResult(message);
                  yield { type: "done", reason: "stop", message };
                  return;
                }
                assert.equal(await session!.followUp("Queued follow-up must not run"), "queued");
                assert.deepEqual(session!.getFollowUpMessages(), ["Queued follow-up must not run"]);
                queued = true;
                const toolCall = {
                  type: "toolCall" as const,
                  id: "never-start",
                  name: "side_effect",
                  arguments: { text: "x".repeat(1000) },
                };
                if (mode === "tui") {
                  message.content.push({ type: "thinking", thinking: "x".repeat(1000) });
                  yield { type: "thinking_start", contentIndex: 0, partial: message };
                  yield {
                    type: "thinking_delta",
                    contentIndex: 0,
                    delta: "x".repeat(1000),
                    partial: message,
                  };
                }
                const toolIndex = message.content.length;
                message.content.push(toolCall);
                yield { type: "toolcall_start", contentIndex: toolIndex, partial: message };
                yield {
                  type: "toolcall_delta",
                  delta: '{"text":"' + "x".repeat(1000) + '"}',
                  contentIndex: toolIndex,
                  partial: message,
                };
                if (!raceDone && options?.signal && !options.signal.aborted) {
                  await new Promise<void>((resolve) =>
                    options.signal!.addEventListener("abort", () => resolve(), { once: true }),
                  );
                }
                yield { type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: message };
                if (raceDone) {
                  resolveResult(message);
                  yield { type: "done", reason: "toolUse", message };
                } else {
                  message.stopReason = "aborted";
                  message.errorMessage = "Fake provider aborted";
                  resolveResult(message);
                  yield { type: "error", reason: "aborted", error: message };
                }
              },
            } as unknown as FakeStream;
          },
        };
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const settingsManager = SettingsManager.inMemory({
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
            compaction: { enabled: false },
          });
          const modelRuntime = await ModelRuntime.create({
            authPath: join(directory, "auth.json"),
            modelsPath: null,
            modelsStorePath: join(directory, "models-store.json"),
            refreshOnCreate: false,
            allowModelNetwork: false,
          });
          const resourceLoader = new DefaultResourceLoader({
            cwd: directory,
            agentDir: directory,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              streamRepetitionGuard,
              (pi) => pi.registerProvider("repetition-test", provider),
            ],
          });
          await resourceLoader.reload();
          const sessionManager = SessionManager.inMemory(directory);
          ({ session } = await createAgentSession({
            cwd: directory,
            agentDir: directory,
            settingsManager,
            modelRuntime,
            resourceLoader,
            sessionManager,
            model: {
              id: "free",
              name: "Free fake",
              reasoning: false,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 10000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              api: "repetition-test",
              provider: "repetition-test",
              baseUrl: "http://unused.invalid",
            },
            tools: ["side_effect"],
            customTools: [
              {
                name: "side_effect",
                label: "Side effect",
                description: "Must never execute",
                parameters: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                } as any,
                execute: async () => {
                  executions++;
                  return { content: [{ type: "text", text: "executed" }], details: {} };
                },
              },
            ],
          }));
          if (mode === "tui") {
            initTheme("dark", false);
            const sdkRoot = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
            const { InteractiveMode } = await import(
              fileURLToPath(new URL("modes/interactive/interactive-mode.js", sdkRoot))
            );
            tui = Object.assign(Object.create(InteractiveMode.prototype), {
              isInitialized: true,
              runtimeHost: { session },
              chatContainer: new Container(),
              footer: { invalidate() {} },
              ui: { requestRender() {} },
              pendingTools: new Map(),
              entriesRenderedByBoundaryCompaction: new Set(),
              toolOutputExpanded: false,
              streamingComponent: new AssistantMessageComponent(undefined, true),
              maybeSuggestBugReport() {},
            });
            tui.chatContainer.addChild(tui.streamingComponent);
          }
          const events: string[] = [];
          const tuiDeliveries: Promise<void>[] = [];
          session.subscribe((event) => {
            events.push(event.type);
            if (tui && (event.type === "entry_appended" || event.type === "message_end"))
              tuiDeliveries.push(tui.handleEvent(event));
            if (event.type === "message_end" && event.message.role === "assistant")
              finalMessage = event.message;
            if (event.type === "agent_end") assert.equal(event.willRetry, false);
          });
          await session.bindExtensions({});
          await session.prompt("Trigger repetition");
          await Promise.all(tuiDeliveries);
          assert.equal(queued, true);
          assert.equal(streamSignal?.aborted, true);
          assert.equal(requests, 1);
          assert.equal(executions, 0);
          assert.equal(finalMessage?.stopReason, "aborted");
          const reasonPattern = new RegExp(
            `stream-repetition-guard.*${mode === "tui" ? "thinking" : "toolcall"}.*period=1.*repetitions=1000.*repeatedCharacters=1000`,
          );
          if (tui) {
            assert.equal(finalMessage?.errorMessage, "Operation aborted");
            const displayed = stripAnsi(tui.chatContainer.render(120).join("\n"));
            assert.match(displayed.replace(/\n/g, ""), reasonPattern);
            assert.ok(!displayed.includes("x".repeat(1000)));
          } else {
            assert.match(finalMessage?.errorMessage ?? "", reasonPattern);
            const parentResult = await consumeParentResult(finalMessage!);
            assert.equal(parentResult.isError, true);
            assert.equal(parentResult.details.results[0].stopReason, "aborted");
            assert.equal(parentResult.details.results[0].errorMessage, finalMessage?.errorMessage);
            assert.match(parentResult.content[0].text, reasonPattern);
          }
          assert.ok(!events.includes("auto_retry_start"));
          assert.ok(!events.includes("auto_compaction_start"));
          assert.ok(!events.includes("tool_execution_start"));
          const entries = sessionManager.getEntries();
          const records = entries.filter(
            (entry) => entry.type === "custom" && entry.customType === "stream-repetition-guard",
          );
          assert.equal(records.length, 1);
          assert.ok(records[0]?.type === "custom");
          assert.match((records[0].data as { reason: string }).reason, reasonPattern);
          assert.ok(!JSON.stringify(records[0]).includes("x".repeat(1000)));
          const persisted = entries.find(
            (entry) => entry.type === "message" && entry.message.role === "assistant",
          );
          assert.ok(persisted?.type === "message");
          assert.deepEqual(persisted.message, finalMessage);
          session.clearQueue();
          ordinaryNextRun = true;
          tui = undefined;
          await session.prompt("New explicit run");
          assert.equal(requests, 2);
          assert.equal(finalMessage?.stopReason, "stop");
          assert.equal(
            sessionManager
              .getEntries()
              .filter(
                (entry) =>
                  entry.type === "custom" && entry.customType === "stream-repetition-guard",
              ).length,
            1,
          );
        } finally {
          session?.dispose();
          await rm(directory, { recursive: true, force: true });
        }
      }, 15000);
    }
  }
});

async function consumeParentResult(message: AssistantMessage): Promise<any> {
  const originalSpawn = __spawn.current;
  const originalFs = __fs.current;
  let tool: any;
  try {
    __fs.current = { mkdirSync: (() => {}) as typeof __fs.current.mkdirSync };
    __spawn.current = (() => {
      const child = new EventEmitter() as any;
      child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
      child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ type: "message_end", message }) + "\n"),
        );
        child.emit("close", 0);
      });
      return child;
    }) as typeof __spawn.current;
    agentsExtension(
      {
        on() {},
        registerFlag() {},
        registerCommand() {},
        registerTool(definition: any) {
          tool = definition;
        },
      } as any,
      {
        config: {
          default: "parent",
          classes: { free: [] },
          agents: {
            parent: { class: "free", tools: ["*"], subagents: ["child"], systemPrompt: [] },
            child: { class: "free", tools: [], subagents: [], systemPrompt: [] },
          },
        },
      },
    );
    return await tool.execute(
      "fixture",
      { task: "Free consumer fixture", agent: "child" },
      undefined,
      undefined,
      { cwd: "/tmp" },
    );
  } finally {
    __spawn.current = originalSpawn;
    __fs.current = originalFs;
    __resetRoutingState();
  }
}
