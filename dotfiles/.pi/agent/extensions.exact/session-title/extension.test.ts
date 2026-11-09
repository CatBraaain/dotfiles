import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { describe, it } from "bun:test";
import {
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import { registerSessionTitle } from "./extension.ts";
import agentsExtension, { __resetRoutingState } from "../agents/index.ts";
import { fakeModel, fakeProvider, memoryRuntime } from "../recontext/test-fixture.ts";

type ResolveClassModels = Parameters<typeof registerSessionTitle>[1];
type Resolution = { class: string; context: ExtensionContext; signal?: AbortSignal };

function assistant(
  stopReason: AssistantMessage["stopReason"] = "stop",
  text = "A useful response",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "chat",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function harness(
  options: {
    complete?: () => Promise<AssistantMessage>;
    resolve?: ResolveClassModels;
  } = {},
) {
  let manager = SessionManager.inMemory("/tmp");
  const handlers = new Map<string, (event: never, ctx: ExtensionCommandContext) => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const queued: string[] = [];
  const notifications: string[] = [];
  const names: string[] = [];
  const calls: Array<{ model: Model<Api>; context: Context; options: unknown }> = [];
  const resolutions: Resolution[] = [];
  const started = deferred<void>();
  let idle = true;
  const parentModel = { provider: "parent", id: "expensive" } as Model<Api>;
  const lowModel = { provider: "test", id: "low" } as Model<Api>;
  const context = {
    get sessionManager() {
      return manager;
    },
    hasUI: true,
    cwd: "/tmp",
    model: parentModel,
    thinkingLevel: "high",
    isIdle: () => idle,
    ui: { notify: (message: string) => notifications.push(message) },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      async complete(model: Model<Api>, request: Context, completeOptions: unknown) {
        calls.push({ model, context: request, options: completeOptions });
        started.resolve();
        return options.complete ? options.complete() : assistant("stop", "Generated title");
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on(name: string, handler: (event: never, ctx: ExtensionCommandContext) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, definition: { handler: typeof command }) {
      command = definition.handler;
    },
    sendUserMessage(text: string, messageOptions: unknown) {
      assert.deepEqual(messageOptions, { expandPromptTemplates: true });
      queued.push(text);
    },
    appendEntry(customType: string, data: unknown) {
      manager.appendCustomEntry(customType, data);
    },
    setSessionName(name: string) {
      names.push(name);
      manager.appendSessionInfo(name);
    },
  } as unknown as ExtensionAPI;
  async function resolveClassModels(
    className: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    resolutions.push({ class: className, context: ctx, signal });
    return options.resolve ? options.resolve(className, ctx, signal) : [lowModel];
  }
  registerSessionTitle(pi, resolveClassModels);

  async function emit(name: string, event: Record<string, unknown> = {}) {
    await handlers.get(name)?.({ type: name, ...event } as never, context);
  }
  async function respond(message = assistant()) {
    idle = false;
    await emit("turn_start");
    manager.appendMessage(message);
    await emit("turn_end", { message });
  }
  async function settle(aborted = false) {
    idle = true;
    await emit("agent_settled", { aborted });
  }
  async function flush() {
    while (queued.length) await command(queued.shift()!.slice("/retitle ".length), context);
  }
  async function finish() {
    await respond();
    await settle();
    await flush();
  }
  return {
    context,
    calls,
    resolutions,
    queued,
    notifications,
    names,
    started: started.promise,
    get manager() {
      return manager;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    emit,
    respond,
    settle,
    flush,
    finish,
    retitle: () => command("", context),
    user(text = "Discuss session titles") {
      return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    },
    async reinstall(reason: string) {
      await emit("session_shutdown");
      handlers.clear();
      registerSessionTitle(pi, resolveClassModels);
      await emit("session_start", { reason });
    },
    async switchSession() {
      await emit("session_shutdown");
      manager = SessionManager.inMemory("/tmp");
      await emit("session_start", { reason: "new" });
    },
    projection(id: string, sessionId = manager.getSessionId()) {
      manager.appendCustomEntry("recontext-projection", { id, sessionId });
    },
    commit(id: string) {
      manager.appendCustomEntry("recontext-committed", id);
    },
  };
}

describe("automatic session titles", () => {
  it("runs once after the first settled response without working in notification handlers", async () => {
    const h = harness();
    h.user();
    await h.respond();
    const entriesBefore = h.manager.getEntries().length;
    await h.settle();
    assert.equal(h.calls.length, 0);
    assert.equal(h.manager.getEntries().length, entriesBefore);
    assert.equal(h.queued.length, 1);
    await h.flush();
    assert.deepEqual(h.names, ["Generated title"]);
    assert.equal(h.manager.getSessionName(), "Generated title");
    const conversationMessages = h.manager.getEntries().filter((entry) => entry.type === "message");
    assert.equal(conversationMessages.length, 2);
    h.user("Continue");
    await h.finish();
    assert.equal(h.calls.length, 1);
  });

  for (const reason of ["reload", "resume"]) {
    it(`preserves the first-response decision after ${reason}`, async () => {
      const h = harness();
      h.user();
      await h.finish();
      await h.reinstall(reason);
      h.user("More");
      await h.finish();
      assert.equal(h.calls.length, 1);
    });
  }

  it("does not execute between retries or queued runs", async () => {
    const h = harness();
    h.user();
    await h.respond(assistant("error"));
    await h.emit("agent_end");
    assert.equal(h.queued.length, 0);
    await h.emit("agent_start");
    await h.respond();
    await h.emit("agent_end");
    assert.equal(h.queued.length, 0);
    await h.emit("agent_start");
    await h.respond();
    await h.settle();
    await h.flush();
    assert.equal(h.calls.length, 1);
  });

  for (const stopReason of ["aborted", "error", "length", "toolUse"] as const) {
    it(`does not generate automatically after ${stopReason}`, async () => {
      const h = harness();
      h.user();
      await h.respond(assistant(stopReason));
      await h.settle();
      await h.flush();
      assert.equal(h.calls.length, 0);
      await h.finish();
      assert.equal(h.calls.length, 1);
    });
  }

  it("does not consume the first response after an aborted run", async () => {
    const h = harness();
    h.user();
    await h.respond();
    await h.settle(true);
    await h.flush();
    assert.equal(h.calls.length, 0);
    await h.finish();
    assert.equal(h.calls.length, 1);
  });

  it("does not generate after an empty or tool-calling stop", async () => {
    const h = harness();
    h.user();
    await h.respond(assistant("stop", ""));
    await h.settle();
    const message = assistant();
    message.content.push({ type: "toolCall", id: "call", name: "read", arguments: {} });
    await h.respond(message);
    await h.settle();
    assert.equal(h.queued.length, 0);
  });
});

describe("retitle command", () => {
  it("generates immediately when idle and keeps previous session names", async () => {
    const h = harness();
    h.user();
    h.manager.appendSessionInfo("Previous title");
    await h.retitle();
    assert.deepEqual(h.names, ["Generated title"]);
    const savedNames = h.manager
      .getEntries()
      .filter((entry) => entry.type === "session_info")
      .map((entry) => entry.name);
    assert.deepEqual(savedNames, ["Previous title", "Generated title"]);
    assert.equal(h.calls[0]!.model.id, "low");
    assert.equal(h.resolutions[0]!.class, "low");
    assert.equal(h.context.model!.id, "expensive");
    assert.equal(h.context.thinkingLevel, "high");
  });

  it("defers busy commands and coalesces initial, manual, and replacement triggers", async () => {
    const h = harness();
    h.user();
    h.projection("replacement");
    h.commit("replacement");
    h.setIdle(false);
    await h.retitle();
    await h.retitle();
    assert.equal(h.calls.length, 0);
    await h.finish();
    assert.equal(h.calls.length, 1);
    await h.finish();
    assert.equal(h.calls.length, 1);
  });

  it("coalesces a manual command with an already reserved automatic command", async () => {
    const h = harness();
    h.user();
    await h.respond();
    await h.settle();
    await h.retitle();
    await h.flush();
    assert.equal(h.calls.length, 1);
    await h.finish();
    assert.equal(h.calls.length, 1);
  });

  it("coalesces commands while inference is in progress", async () => {
    const result = deferred<AssistantMessage>();
    const h = harness({ complete: () => result.promise });
    h.user();
    const first = h.retitle();
    await h.started;
    const second = h.retitle();
    result.resolve(assistant("stop", "One title"));
    await Promise.all([first, second]);
    assert.equal(h.calls.length, 1);
  });

  it("requeues a reserved command when another run starts before dispatch", async () => {
    const h = harness();
    h.user();
    await h.respond();
    await h.settle();
    h.setIdle(false);
    await h.flush();
    assert.equal(h.calls.length, 0);
    await h.finish();
    assert.equal(h.calls.length, 1);
  });
});

describe("completion triggers during title inference", () => {
  for (const trigger of ["manual", "initial", "recontext", "combined"] as const) {
    it(`recovers the ${trigger} trigger after the earlier inference finishes`, async () => {
      const result = deferred<AssistantMessage>();
      const started = deferred<void>();
      let blockNext = false;
      const h = harness({
        complete: async () => {
          if (blockNext) {
            blockNext = false;
            started.resolve();
            return result.promise;
          }
          return assistant("stop", "Fresh title");
        },
      });
      h.user();
      if (trigger === "manual" || trigger === "recontext") await h.finish();
      const previousCalls = h.calls.length;
      blockNext = true;
      const earlier = h.retitle();
      await started.promise;
      h.user("New topic while title inference is running");
      if (trigger === "recontext" || trigger === "combined") {
        h.projection("overlapping-replacement");
        h.commit("overlapping-replacement");
      }
      await h.respond();
      if (trigger === "manual" || trigger === "combined") {
        await h.retitle();
        await h.retitle();
      }
      await h.settle();
      assert.equal(h.queued.length, 0);
      result.resolve(assistant("stop", "Earlier title"));
      await earlier;
      assert.equal(h.queued.length, 1);
      await h.flush();
      assert.equal(h.calls.length, previousCalls + 2);
      const latestInput = h.calls
        .at(-1)!
        .context.messages.find((message) => message.role === "user")!;
      assert.match(String(latestInput.content), /New topic while title inference is running/);
      await h.finish();
      assert.equal(h.calls.length, previousCalls + 2);
    });
  }

  it("recovers a pending completion even when the earlier inference fails", async () => {
    const result = deferred<AssistantMessage>();
    let first = true;
    const h = harness({
      complete: async () => {
        if (first) {
          first = false;
          return result.promise;
        }
        return assistant("stop", "Recovered title");
      },
    });
    h.user();
    const earlier = h.retitle();
    await h.started;
    await h.respond();
    await h.retitle();
    await h.settle();
    result.resolve(assistant("error", ""));
    await earlier;
    await h.flush();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.names, ["Recovered title"]);
    assert.equal(h.notifications.length, 1);
  });

  it("waits for another normal completion when a new response starts before inference finishes", async () => {
    const result = deferred<AssistantMessage>();
    let first = true;
    const h = harness({
      complete: async () => {
        if (first) {
          first = false;
          return result.promise;
        }
        return assistant("stop", "Latest title");
      },
    });
    h.user();
    const earlier = h.retitle();
    await h.started;
    await h.respond();
    await h.retitle();
    await h.settle();
    await h.emit("agent_start");
    await h.respond(assistant("error"));
    result.resolve(assistant("stop", "Earlier title"));
    await earlier;
    assert.equal(h.queued.length, 0);
    await h.settle();
    await h.flush();
    assert.equal(h.calls.length, 1);
    await h.finish();
    assert.equal(h.calls.length, 2);
  });

  for (const change of ["session", "tree", "shutdown"] as const) {
    it(`drops a pending completion after ${change} changes`, async () => {
      const result = deferred<AssistantMessage>();
      const h = harness({ complete: () => result.promise });
      const root = h.user();
      const earlier = h.retitle();
      await h.started;
      await h.respond();
      await h.retitle();
      await h.settle();
      if (change === "session") await h.switchSession();
      if (change === "tree") {
        h.manager.branch(root);
        await h.emit("session_tree");
      }
      if (change === "shutdown") await h.emit("session_shutdown");
      result.resolve(assistant("stop", "Wrong target"));
      await earlier;
      await h.flush();
      assert.equal(h.calls.length, 1);
      assert.equal(h.queued.length, 0);
      assert.deepEqual(h.names, []);
    });
  }
});

describe("recontext titles", () => {
  for (const commitAfterResponse of [false, true]) {
    it(`regenerates after successful replacement with commit ${commitAfterResponse ? "after" : "before"} the response`, async () => {
      const h = harness();
      h.user();
      await h.finish();
      h.projection("replace");
      if (!commitAfterResponse) h.commit("replace");
      await h.respond();
      if (commitAfterResponse) h.commit("replace");
      await h.settle();
      await h.flush();
      assert.equal(h.calls.length, 2);
      await h.reinstall("reload");
      await h.finish();
      assert.equal(h.calls.length, 2);
    });
  }

  it("requires a normal response after projection, not merely a commit", async () => {
    const h = harness();
    h.user();
    await h.finish();
    h.projection("replace");
    h.commit("replace");
    await h.respond(assistant("error"));
    await h.settle();
    await h.flush();
    assert.equal(h.calls.length, 1);
    await h.finish();
    assert.equal(h.calls.length, 2);
  });

  it("ignores requests, pending, rejected, failed, foreign, and uncommitted replacements", async () => {
    const h = harness();
    h.user();
    await h.finish();
    for (const status of ["request", "pending", "rejected", "error"])
      h.manager.appendCustomEntry(`recontext-${status}`, { id: status });
    h.projection("uncommitted");
    h.projection("foreign", "another-session");
    h.commit("foreign");
    await h.finish();
    assert.equal(h.calls.length, 1);
  });

  it("does not use a commit from an abandoned branch", async () => {
    const h = harness();
    h.user();
    await h.finish();
    h.projection("replace");
    const projectionLeaf = h.manager.getLeafId()!;
    h.commit("replace");
    h.manager.branch(projectionLeaf);
    await h.emit("session_tree");
    await h.finish();
    assert.equal(h.calls.length, 1);
  });
});

describe("title input and failures", () => {
  it("uses only raw user and assistant text, including context-edited history", async () => {
    const h = harness();
    const userId = h.user("Original user text");
    const message = assistant("stop", "Original assistant text");
    message.content.push(
      { type: "thinking", thinking: "Private thinking" },
      { type: "toolCall", id: "tool", name: "read", arguments: { path: "secret" } },
    );
    h.manager.appendMessage(message);
    h.manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool",
      toolName: "read",
      content: [{ type: "text", text: "Tool result" }],
      isError: false,
      timestamp: 0,
    });
    h.manager.appendMessage({ role: "system", content: "System instructions", timestamp: 0 });
    h.manager.appendCustomMessageEntry("handoff", "Handoff summary", false);
    h.manager.appendContextEdit(userId, { content: "Replacement summary" });
    await h.retitle();
    const submitted = h.calls[0]!.context.messages.find((entry) => entry.role === "user")!;
    assert.equal(
      submitted.content,
      [
        JSON.stringify({ role: "user", content: "Original user text" }),
        JSON.stringify({ role: "assistant", content: "Original assistant text" }),
      ].join("\n"),
    );
  });

  it("keeps the name and reports missing text", async () => {
    const h = harness();
    h.manager.appendSessionInfo("Keep");
    await h.retitle();
    assert.equal(h.manager.getSessionName(), "Keep");
    assert.equal(h.resolutions.length, 0);
    assert.match(h.notifications[0]!, /No conversation text/);
  });

  it("keeps the name and reports unavailable low models", async () => {
    const h = harness({ resolve: async () => [] });
    h.user();
    h.manager.appendSessionInfo("Keep");
    await h.retitle();
    assert.equal(h.manager.getSessionName(), "Keep");
    assert.equal(h.calls.length, 0);
    assert.match(h.notifications[0]!, /No available model for class low/);
  });

  for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
    it(`keeps the name and reports ${stopReason} inference`, async () => {
      const h = harness({ complete: async () => assistant(stopReason, "Do not save") });
      h.user();
      h.manager.appendSessionInfo("Keep");
      await h.retitle();
      assert.equal(h.manager.getSessionName(), "Keep");
      assert.match(h.notifications[0]!, new RegExp(stopReason));
    });
  }

  it("consumes failed automatic triggers but permits manual retry", async () => {
    let fail = true;
    const h = harness({
      complete: async () => {
        if (fail) throw new Error("Network unavailable");
        return assistant("stop", "Retry title");
      },
    });
    h.user();
    await h.finish();
    assert.match(h.notifications[0]!, /Network unavailable/);
    await h.reinstall("resume");
    await h.finish();
    assert.equal(h.calls.length, 1);
    fail = false;
    await h.retitle();
    assert.deepEqual(h.names, ["Retry title"]);
  });

  it("keeps the name when output has no text", async () => {
    const h = harness({ complete: async () => assistant("stop", "  ") });
    h.user();
    await h.retitle();
    assert.equal(h.names.length, 0);
    assert.match(h.notifications[0]!, /empty title/);
  });

  it("normalizes generated whitespace to one line", async () => {
    const h = harness({ complete: async () => assistant("stop", "  Session\n  title \t") });
    h.user();
    await h.retitle();
    assert.deepEqual(h.names, ["Session title"]);
  });
});

describe("real SDK title command dispatch", () => {
  it("dispatches initial, idle, and overlapping busy retitles without conversation messages", async () => {
    const root = "/tmp/work/dotfiles/session-title";
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(`${root}/sdk-`);
    const previousAgent = process.env.PI_AGENT_NAME;
    const runtime = await memoryRuntime();
    const fake = fakeProvider("title-test");
    fake.state.models = [
      fakeModel({ provider: "title-test", id: "parent" }),
      fakeModel({ provider: "title-test", id: "title" }),
    ];
    let blockTitle = false;
    let blockParent = false;
    const titleStarted = deferred<void>();
    const parentStarted = deferred<void>();
    const releaseTitle = deferred<void>();
    const releaseParent = deferred<void>();
    fake.state.beforeReply = async (capture) => {
      if (capture.model.id === "title" && blockTitle) {
        titleStarted.resolve();
        await releaseTitle.promise;
      }
      if (capture.model.id === "parent" && blockParent) {
        parentStarted.resolve();
        await releaseParent.promise;
      }
      fake.state.normalContent = [
        {
          type: "text",
          text: capture.model.id === "title" ? "Real session title" : "Normal conversation reply",
        },
      ];
    };
    runtime.registerNativeProvider(fake.provider);
    await runtime.refresh({ allowNetwork: false });
    const manager = SessionManager.inMemory(directory);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      defaultTools: [],
      enableInstallTelemetry: false,
    });
    const renamed = deferred<void>();
    const pendingRetitled = deferred<void>();
    let renameCount = 0;
    let titleCommands: string[] = [];
    const errors: unknown[] = [];
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
        (pi) => {
          agentsExtension(pi, {
            config: {
              default: "main",
              defaultMode: "standard",
              modes: {
                standard: {
                  middle: [{ provider: "title-test", model: "parent" }],
                  low: [{ provider: "title-test", model: "title" }],
                },
              },
              agents: { main: { class: "middle", tools: [], subagents: [], systemPrompt: [] } },
            },
          });
          pi.on("session_start", () => {
            titleCommands = pi
              .getCommands()
              .map((command) => command.name)
              .filter((name) => name.startsWith("retitle"));
          });
          pi.on("session_info_changed", () => {
            renameCount++;
            renamed.resolve();
            if (renameCount === 4) pendingRetitled.resolve();
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: runtime.getModel("title-test", "parent")!,
      thinkingLevel: "off",
      settingsManager: settings,
      sessionManager: manager,
      resourceLoader: loader,
      tools: [],
    });
    try {
      await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
      assert.deepEqual(titleCommands, ["retitle"]);
      await session.prompt("Discuss useful session titles");
      await renamed.promise;
      assert.equal(manager.getSessionName(), "Real session title");
      assert.equal(session.model!.id, "parent");
      assert.equal(session.thinkingLevel, "off");
      await session.prompt("Continue the same conversation");
      assert.equal(fake.state.requests.filter((request) => request.model.id === "title").length, 1);
      await session.prompt("/retitle");
      assert.equal(fake.state.requests.filter((request) => request.model.id === "title").length, 2);
      blockTitle = true;
      const manualTitle = session.prompt("/retitle");
      await titleStarted.promise;
      blockParent = true;
      const nextResponse = session.prompt("Discuss a different topic");
      await parentStarted.promise;
      await session.prompt("/retitle");
      releaseParent.resolve();
      await nextResponse;
      releaseTitle.resolve();
      await manualTitle;
      await pendingRetitled.promise;
      assert.equal(fake.state.requests.filter((request) => request.model.id === "title").length, 4);
      const latestTitle = fake.state.requests
        .filter((request) => request.model.id === "title")
        .at(-1)!;
      assert.match(JSON.stringify(latestTitle.context.messages), /Discuss a different topic/);
      const history = manager
        .getEntries()
        .filter(
          (entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role),
        );
      assert.equal(history.length, 6);
      assert.deepEqual(errors, []);
    } finally {
      session.dispose();
      __resetRoutingState();
      if (previousAgent === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = previousAgent;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("title destination safety", () => {
  for (const change of ["session", "tree", "shutdown"] as const) {
    it(`discards an in-flight result after ${change} changes`, async () => {
      const result = deferred<AssistantMessage>();
      const h = harness({ complete: () => result.promise });
      const first = h.user();
      const operation = h.retitle();
      await h.started;
      if (change === "session") await h.switchSession();
      if (change === "tree") {
        h.manager.branch(first);
        await h.emit("session_tree");
      }
      if (change === "shutdown") await h.emit("session_shutdown");
      h.manager.appendSessionInfo("Keep new target");
      result.resolve(assistant("stop", "Wrong title"));
      await operation;
      assert.equal(h.manager.getSessionName(), "Keep new target");
      assert.equal(h.names.length, 0);
    });
  }

  it("accepts same-branch metadata appended during inference", async () => {
    const result = deferred<AssistantMessage>();
    const h = harness({ complete: () => result.promise });
    h.user();
    const operation = h.retitle();
    await h.started;
    h.manager.appendCustomEntry("other-extension", { status: "updated" });
    result.resolve(assistant("stop", "Correct title"));
    await operation;
    assert.deepEqual(h.names, ["Correct title"]);
  });

  it("rejects a different branch even without a tree notification", async () => {
    const result = deferred<AssistantMessage>();
    const h = harness({ complete: () => result.promise });
    const root = h.user();
    h.manager.appendMessage(assistant());
    const operation = h.retitle();
    await h.started;
    h.manager.branch(root);
    h.user("Alternative branch");
    result.resolve(assistant("stop", "Wrong title"));
    await operation;
    assert.equal(h.names.length, 0);
  });
});
