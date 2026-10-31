import { Type } from "typebox";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { describe, it } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import replaceContextExtension from "./index.ts";
import { fakeProvider, memoryRuntime, seedConversation } from "./test-fixture.ts";
import { REPLACEMENT_STATE } from "./projection.ts";

interface FixtureOptions {
  virtual?: boolean;
  transform?: boolean;
  warming?: boolean;
  counter?: number;
  largeTool?: boolean;
  expandedInput?: boolean;
  legacySummary?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const root = "/tmp/work/dotfiles/cache-preserving-compaction-qa";
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(`${root}/sdk-`);
  mkdirSync(`${directory}/.git`);
  const manager = SessionManager.inMemory(directory);
  const seed = seedConversation(manager, 12_500);
  if (options.legacySummary) manager.appendCompaction("LEGACY STANDARD SUMMARY", seed.old, 1);
  if (options.counter !== undefined)
    manager.appendCustomEntry("handoff-session-counter", {
      type: "handoff-session-counter",
      version: 1,
      count: options.counter,
    });
  const runtime = await memoryRuntime();
  const fake = fakeProvider(
    undefined,
    options.warming
      ? {
          promptCache: { short: 11 },
          cost: { input: 10, output: 1, cacheRead: 0.01, cacheWrite: 0 },
        }
      : {},
  );
  runtime.registerNativeProvider(fake.provider);
  await runtime.refresh({ allowNetwork: false });
  const physical = runtime.getModel(fake.provider.id, "physical")!;
  const routes: string[] = [];
  let model = physical;
  if (options.virtual) {
    runtime.registerVirtualModel({
      provider: "memory-router",
      id: "auto",
      name: "Memory route",
      thinkingLevels: ["off"],
      route(request) {
        routes.push(request.reason);
        return { model: physical, thinkingLevel: "off" };
      },
    });
    await runtime.refresh({ allowNetwork: false });
    model = runtime.getModel("memory-router", "auto")!;
  }
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1_000, reserveTokens: 512 },
    retry: { enabled: false },
    cacheWarming: options.warming ? "streaming" : "off",
    enableInstallTelemetry: false,
    defaultTools: [],
  });
  const notices: string[] = [];
  const errors: unknown[] = [];
  const callbacks: string[] = [];
  const warmingDecision = Promise.withResolvers<void>();
  let api!: ExtensionAPI;
  let context!: ExtensionContext;
  let enabled = true;
  let contextCalls = 0;
  let systemCalls = 0;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Effective system instructions.",
    extensionFactories: [
      (pi) => {
        if (enabled) replaceContextExtension(pi);
      },
      (pi) => {
        api = pi;
        if (options.largeTool)
          pi.registerTool({
            name: "large_result",
            label: "Large result",
            description: "Return a synthetic large result.",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [
                  {
                    type: "text",
                    text: "LARGE_RESULT_BEGIN" + "x".repeat(100_000) + "LARGE_RESULT_END",
                  },
                ],
                details: undefined,
              };
            },
          });
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
        pi.on("context", (event) => {
          contextCalls++;
          if (options.expandedInput)
            return {
              messages: event.messages.map((message) =>
                message.role === "user" && JSON.stringify(message.content).includes("EXPAND INPUT")
                  ? { ...message, content: "EXPANDED INPUT" + "x".repeat(100_000) }
                  : message,
              ),
            };
          if (!options.transform) return;
          return {
            messages: event.messages.map((message) =>
              message.role === "user" && typeof message.content === "string"
                ? { ...message, content: `TRANSFORMED ${message.content}` }
                : message,
            ),
          };
        });
        pi.on("context_with_system", (event) => {
          systemCalls++;
          if (!options.transform) return;
          return {
            messages: event.messages.map((message, index) =>
              index === 0 && message.role === "system"
                ? {
                    ...message,
                    content: `${typeof message.content === "string" ? message.content : ""}\nFINAL SYSTEM TRANSFORM`,
                  }
                : message,
            ),
          };
        });
        pi.on("before_provider_request", () => {
          callbacks.push("payload");
        });
        pi.on("after_provider_response", (event) => {
          callbacks.push(`response:${event.status}`);
        });
        pi.on("provider_stream_event", () => {
          callbacks.push("stream");
        });
        pi.on("cache_warming_decision", () => {
          warmingDecision.resolve();
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
    tools: options.largeTool ? ["large_result"] : [],
  });
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify(message) {
        notices.push(message);
      },
      async select() {
        return "Yes, replace context";
      },
    },
    onError(error) {
      errors.push(error);
    },
  });
  function dispose() {
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
  function disable() {
    enabled = false;
  }
  function getContext() {
    return context;
  }
  function getApi() {
    return api;
  }
  function hookCounts() {
    return { context: contextCalls, system: systemCalls };
  }
  return {
    ...fake,
    runtime,
    manager,
    physical,
    session,
    notices,
    errors,
    callbacks,
    warmingDecision,
    routes,
    dispose,
    disable,
    getContext,
    getApi,
    hookCounts,
  };
}

function stateCount(h: Awaited<ReturnType<typeof fixture>>) {
  return h.manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === REPLACEMENT_STATE).length;
}

function currentModelText(h: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(convertToLlm(h.manager.buildSessionProjection().messages));
}

describe("real AgentSession automatic compaction", () => {
  it("uses physical routing and both context transformations once before the final provider fork", async () => {
    const h = await fixture({ virtual: true, transform: true });
    try {
      await h.session.prompt("new user prompt", { source: "extension" });
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      const [summary, normal] = h.state.requests;
      assert.equal(summary!.model.id, "physical");
      assert.equal(summary!.model.provider, h.provider.id);
      assert.strictEqual(summary!.model, normal!.model);
      assert.deepEqual(h.routes, ["user"]);
      assert.deepEqual(h.hookCounts(), { context: 1, system: 1 });
      assert.match(JSON.stringify(summary!.context), /FINAL SYSTEM TRANSFORM/);
      assert.match(JSON.stringify(summary!.context), /TRANSFORMED OLD /);
      assert.match(JSON.stringify(normal!.context), /TRANSFORMED RECENT/);
      assert.doesNotMatch(JSON.stringify(normal!.context), /OLD |old answer/);
      assert.equal(stateCount(h), 1);
      assert.ok(h.manager.getEntries().some((entry) => entry.type === "context_edit"));
      assert.doesNotMatch(currentModelText(h), /OLD |old answer/);
      assert.match(JSON.stringify(h.manager.getEntries()), /OLD |old answer/);
      assert.deepEqual(h.callbacks, ["payload", "response:200", "stream"]);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  for (const delivery of ["steer", "followUp"] as const) {
    it(`keeps ${delivery} input queued during summary and uses its full original content later`, async () => {
      const h = await fixture();
      try {
        let queued = false;
        h.state.beforeReply = async (capture) => {
          if (capture.kind !== "summary" || queued) return;
          queued = true;
          assert.equal(
            await h.session[delivery]("QUEUED ORIGINAL INPUT", undefined, { source: "extension" }),
            "queued",
          );
        };
        await h.session.prompt("new user prompt", { source: "extension" });
        assert.equal(stateCount(h), 1);
        assert.ok(
          h.state.requests.some(
            (request) =>
              request.kind === "normal" &&
              JSON.stringify(request.context.messages).includes("QUEUED ORIGINAL INPUT"),
          ),
        );
        assert.match(currentModelText(h), /QUEUED ORIGINAL INPUT/);
        assert.doesNotMatch(currentModelText(h), /OLD |old answer/);
        assert.deepEqual(h.session.getSteeringMessages(), []);
        assert.deepEqual(h.session.getFollowUpMessages(), []);
        assert.deepEqual(h.errors, []);
      } finally {
        h.dispose();
      }
    });
  }

  it("checks a newly expanded request before any lower provider send", async () => {
    const h = await fixture({ expandedInput: true });
    try {
      await h.session.prompt("EXPAND INPUT", { source: "extension" });
      assert.deepEqual(h.state.requests, []);
      assert.equal(stateCount(h), 0);
      assert.match(JSON.stringify(h.manager.getEntries()), /EXPAND INPUT/);
      assert.equal(h.notices.length, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("keeps an oversized new tool result whole and blocks the next lower ordinary stream", async () => {
    const h = await fixture({ largeTool: true });
    try {
      h.state.beforeReply = (capture) => {
        if (capture.kind !== "normal") return;
        if (h.state.requests.filter((request) => request.kind === "normal").length > 1) {
          h.state.normalReason = "stop";
          h.state.normalContent = undefined;
          return;
        }
        h.state.normalReason = "toolUse";
        h.state.normalContent = [
          { type: "toolCall", id: "large-call", name: "large_result", arguments: {} },
        ];
      };
      await h.session.prompt("produce the large fixture result", { source: "extension" });
      const result = h.manager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "large_result",
        );
      assert.ok(
        result?.type === "message" && result.message.role === "toolResult",
        JSON.stringify(
          h.manager
            .getBranch()
            .filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
        ),
      );
      const content = result.message.content[0];
      assert.ok(content?.type === "text");
      const expectedResult = "LARGE_RESULT_BEGIN" + "x".repeat(100_000) + "LARGE_RESULT_END";
      assert.equal(content.text.length, expectedResult.length);
      assert.equal(content.text, expectedResult);
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.equal(stateCount(h), 1);
      assert.match(h.notices.at(-1)!, /both summary and normal/);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("persists successful summary edits even when the ordinary turn ends in error", async () => {
    const h = await fixture({ counter: 2 });
    try {
      h.state.normalReason = "error";
      await h.session.prompt("failed ordinary turn", { source: "extension" });
      assert.equal(stateCount(h), 1);
      assert.ok(h.manager.getEntries().some((entry) => entry.type === "context_edit"));
      assert.doesNotMatch(currentModelText(h), /OLD |old answer/);
      const counters = h.manager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "handoff-session-counter",
        );
      assert.equal(counters.length, 1);
      assert.equal((counters[0] as { data: { count: number } }).data.count, 2);
      h.state.normalReason = "stop";
      const before = h.state.requests.length;
      await h.session.prompt("retry as a new user request", { source: "extension" });
      assert.deepEqual(
        h.state.requests.slice(before).map((request) => request.kind),
        ["normal"],
      );
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("keeps summary 429 isolated from ordinary callbacks and sends no ordinary stream", async () => {
    const h = await fixture();
    try {
      h.state.summaryReason = "error";
      const raw = JSON.stringify(h.manager.getEntries());
      await h.session.prompt("new user prompt", { source: "extension" });
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary"],
      );
      assert.deepEqual(h.callbacks, []);
      assert.equal(stateCount(h), 0);
      assert.equal(
        h.manager.getEntries().filter((entry) => entry.type === "context_edit").length,
        0,
      );
      assert.match(JSON.stringify(h.manager.getEntries()), /OLD |old answer/);
      assert.ok(raw.includes("OLD "));
      assert.match(h.notices[0]!, /not accepted/);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("compacts an immutable prior summary without editing it and keeps it suppressed on the following request", async () => {
    const h = await fixture({ legacySummary: true });
    try {
      const legacy = structuredClone(
        h.manager.getBranch().find((entry) => entry.type === "compaction"),
      );
      await h.session.prompt("new user prompt", { source: "extension" });
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.match(JSON.stringify(h.state.requests[0]!.context), /LEGACY STANDARD SUMMARY/);
      assert.doesNotMatch(
        JSON.stringify(h.state.requests[1]!.context),
        /LEGACY STANDARD SUMMARY|OLD |old answer/,
      );
      await h.session.prompt("following user prompt", { source: "extension" });
      assert.doesNotMatch(
        JSON.stringify(h.state.requests.at(-1)!.context),
        /LEGACY STANDARD SUMMARY|OLD |old answer/,
      );
      assert.deepEqual(h.manager.getEntry(legacy!.id), legacy);
      assert.equal(stateCount(h), 1);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("maintains state and a fresh provider gate after actual extension reload", async () => {
    const h = await fixture();
    try {
      await h.session.prompt("new user prompt", { source: "extension" });
      const oldGate = h.runtime.getRegisteredNativeProvider(h.provider.id);
      await h.session.reload();
      assert.notStrictEqual(h.runtime.getRegisteredNativeProvider(h.provider.id), oldGate);
      await h.session.prompt("after reload", { source: "extension" });
      assert.equal(stateCount(h), 1);
      assert.doesNotMatch(JSON.stringify(h.state.requests.at(-1)!.context), /OLD |old answer/);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("restores the underlying provider when reload disables the extension", async () => {
    const h = await fixture();
    try {
      h.disable();
      await h.session.reload();
      assert.strictEqual(h.runtime.getRegisteredNativeProvider(h.provider.id), h.provider);
      assert.equal(stateCount(h), 0);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("leaves standard manual compaction available with its original entry type", async () => {
    const h = await fixture();
    try {
      const result = await h.session.compact();
      assert.match(result.summary, /Normal reply/);
      assert.equal(h.manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
      assert.equal(stateCount(h), 0);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("stops a real SDK cache-warming decision while summary owns the session affinity", async () => {
    const h = await fixture({ warming: true });
    try {
      for (const entry of h.manager.getBranch()) {
        if (entry.type === "message" && entry.message.role === "assistant")
          entry.message.usage = { ...entry.message.usage, input: 50_000, totalTokens: 50_000 };
      }
      h.state.beforeReply = async (capture) => {
        if (capture.kind === "summary") await h.warmingDecision.promise;
      };
      await h.session.prompt("new user prompt", { source: "extension" });
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.equal(
        h.state.requests.some((request) => request.options.maxTokens === 1),
        false,
      );
      assert.equal(h.state.maxActive, 1);
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });
});
