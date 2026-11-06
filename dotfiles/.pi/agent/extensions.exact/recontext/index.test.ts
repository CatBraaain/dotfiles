import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryModelsStore,
  type Api,
  type Credential,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type SessionEntry, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  SessionManager,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  BoundaryResult,
  ExtensionContext,
  ExtensionAPI,
  InputEvent,
  ToolDefinition,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CLASS_CHANGE_EVENT,
  type ClassChangeRequest,
  type ClassChangeResult,
} from "../agents/class-change.ts";
import agentsExtension from "../agents/index.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import recontextExtension from "./index";
import { projectPendingMessages } from "./projection.ts";
import { renderersOf } from "../tool-renderer/index.ts";

function isHandoffEntry(
  entry: SessionEntry,
): entry is CustomEntry<{ count: number; requestId: string }> {
  return (
    entry.type === "custom" &&
    entry.customType === "handoff-session-counter" &&
    !!entry.data &&
    typeof (entry.data as { requestId?: unknown }).requestId === "string"
  );
}

function harness(manager = SessionManager.inMemory()) {
  let tool: ToolDefinition;
  let input: (event: InputEvent) => void;
  let turn: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<BoundaryResult | undefined>;
  const sent: string[] = [];
  const notices: string[] = [];
  const selections: string[] = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const classChange = { complete: () => Promise.resolve<ClassChangeResult>("applied") };
  const controller = new AbortController();
  const ctx = {
    sessionManager: manager,
    signal: controller.signal,
    hasUI: true,
    ui: {
      select: async (title: string): Promise<string | undefined> => {
        selections.push(title);
        return "Yes, recontext";
      },
      confirm: async () => true,
      input: async () => "",
      notify: (message: string) => {
        notices.push(message);
      },
    },
  };
  recontextExtension({
    on(name: string, handler: never) {
      if (name === "input") input = handler;
      if (name === "turn_end") turn = handler;
    },
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
    appendEntry(customType: string, data: unknown) {
      manager.appendCustomEntry(customType, data);
    },
    sendUserMessage(text: string) {
      sent.push(text);
    },
    events: {
      emit(channel: string, data: unknown) {
        const request = data as ClassChangeRequest;
        emitted.push({ channel, data: { class: request.class, source: request.source } });
        request.respond(classChange.complete());
      },
    },
  } as never);

  async function request(
    params: Record<string, unknown> = { reason: "phase done", handoff: "next phase" },
    toolCallId = "call",
  ) {
    return tool.execute(toolCallId, params, undefined, undefined, ctx as never);
  }
  async function boundary(
    options: Partial<TurnEndEvent> = {},
    requestParams: Record<string, unknown> | undefined = undefined,
  ) {
    if (manager.getEntries().length === 0)
      manager.appendMessage({ role: "user", content: "initial phase", timestamp: Date.now() });
    const result = await request(requestParams);
    const toolCallId = `call-${manager.getEntries().length}`;
    const toolResult = {
      role: "toolResult" as const,
      toolName: "recontext",
      toolCallId,
      content: result.content,
      details: result.details as TurnEndEvent["toolResults"][number]["details"],
      isError: false,
      timestamp: Date.now(),
    };
    const message = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: toolCallId, name: "recontext", arguments: {} }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };
    const messageEntryId = manager.appendMessage(message);
    const toolResultEntryIds = [manager.appendMessage(toolResult)];
    const event: TurnEndEvent = {
      type: "turn_end",
      turnIndex: 0,
      message,
      toolResults: [toolResult],
      messageEntryId,
      toolResultEntryIds,
      entries: [],
      continue: false,
      outcome: "completed",
      context: {
        contextEntries: [],
        contextMessages: [],
        llmMessages: [],
        pendingMessages: [],
        canContinue: true,
      },
      ...options,
    };
    return turn(event, ctx as unknown as ExtensionContext);
  }
  function commit(result: BoundaryResult | undefined) {
    for (const entry of result?.entries ?? []) {
      if (entry.type === "compaction")
        manager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true);
      if (entry.type === "custom") manager.appendCustomEntry(entry.customType, entry.data);
      if (entry.type === "custom_message")
        manager.appendCustomMessageEntry(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
        );
      if (entry.type === "context_edit")
        manager.appendContextEdit(entry.targetId, entry.replacement);
    }
  }
  function user(source: InputEvent["source"] = "interactive") {
    input({ type: "input", source, text: "continue" });
  }
  return {
    manager,
    ctx,
    sent,
    selections,
    notices,
    emitted,
    classChange,
    controller,
    request,
    boundary,
    commit,
    user,
    tool: () => tool,
  };
}

interface ProviderRequest {
  model: string;
  messages: unknown[];
  system?: unknown;
  tools?: { name: string }[];
}

async function runtimeHarness(withAgents = false) {
  const directory = mkdtempSync(join(tmpdir(), "handoff-runtime-"));
  mkdirSync(join(directory, ".git"));
  const requests: ProviderRequest[] = [];
  const inputs: InputEvent[] = [];
  const selections: string[] = [];
  const notices: string[] = [];
  const errors: unknown[] = [];
  const classChanges: Array<{ class: string }> = [];
  const hooks: {
    duringTool?: (pi: ExtensionAPI) => Promise<void>;
    duringSelect?: () => Promise<string | undefined>;
    duringReason?: () => Promise<string | undefined>;
  } = {};
  let requestHandoff = false;
  let requestHandoffClass: string | undefined;
  function fakeStream(model: Model<Api>, context: TranscriptContext) {
    requests.push({
      model: model.id,
      messages: context.messages,
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages),
    });
    const handoff = requestHandoff;
    requestHandoff = false;
    const output = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: handoff
        ? [
            {
              type: "toolCall" as const,
              id: `handoff-${requests.length}`,
              name: "recontext",
              arguments: {
                reason: "phase done",
                handoff: "new phase marker",
                ...(requestHandoffClass !== undefined ? { class: requestHandoffClass } : {}),
              },
            },
          ]
        : [{ type: "text" as const, text: "fake final response" }],
      stopReason: handoff ? ("toolUse" as const) : ("stop" as const),
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      output.push({ type: "start", partial: message });
      output.push({ type: "done", reason: handoff ? "toolUse" : "stop", message });
      output.end();
    });
    return output;
  }
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: memoryCredentials(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider({
    id: "handoff-test",
    name: "Memory fake",
    baseUrl: "https://fake.invalid",
    auth: {
      apiKey: {
        name: "Fake",
        async check() {
          return { type: "api_key", source: "test" };
        },
        async resolve() {
          return { auth: { apiKey: "fake-key" }, source: "test" };
        },
      },
    },
    stream: fakeStream,
    streamSimple: fakeStream,
    getModels() {
      return [
        "fake-model",
        "high-model",
        "low-model",
        "max-middle-model",
        "max-high-model",
        "max-low-model",
      ].map((id) => ({
        id,
        provider: "handoff-test",
        api: "anthropic-messages",
        baseUrl: "https://fake.invalid",
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      }));
    },
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Keep this system marker.",
    extensionFactories: [
      ...(withAgents
        ? [
            (pi: ExtensionAPI) =>
              agentsExtension(pi, {
                config: {
                  default: "main",
                  defaultMode: "standard",
                  modes: {
                    standard: {
                      middle: [{ provider: "handoff-test", model: "fake-model" }],
                      high: [{ provider: "handoff-test", model: "high-model" }],
                      low: [{ provider: "handoff-test", model: "low-model" }],
                    },
                    max: {
                      middle: [{ provider: "handoff-test", model: "max-middle-model" }],
                      high: [{ provider: "handoff-test", model: "max-high-model" }],
                      low: [{ provider: "handoff-test", model: "max-low-model" }],
                    },
                  },
                  agents: {
                    main: {
                      class: "middle",
                      tools: ["recontext"],
                      subagents: [],
                      systemPrompt: [],
                    },
                  },
                },
              }),
          ]
        : []),
      recontextExtension,
      (pi) => {
        pi.events.on(CLASS_CHANGE_EVENT, (data) => {
          classChanges.push({ class: (data as ClassChangeRequest).class! });
        });
      },
      (pi) => {
        pi.on("input", (event) => {
          inputs.push(event);
        });
        pi.on("tool_result", async (event) => {
          if (event.toolName === "recontext") await hooks.duringTool?.(pi);
        });
      },
    ],
  });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(directory);
  const model = modelRuntime.getModel("handoff-test", "fake-model");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model,
    thinkingLevel: "off",
    settingsManager,
    sessionManager: manager,
    resourceLoader,
    tools: ["recontext"],
  });
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      async select(title) {
        selections.push(title);
        return hooks.duringSelect ? await hooks.duringSelect() : "Yes, recontext";
      },
      async input() {
        return hooks.duringReason ? await hooks.duringReason() : "";
      },
      notify(message) {
        notices.push(message);
      },
    },
    onError(error) {
      errors.push(error);
    },
  });
  async function handoff(options: { class?: string } = {}) {
    requestHandoff = true;
    requestHandoffClass = options.class;
    await session.prompt("request the phase transition", { source: "extension" });
  }
  function dispose() {
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    session,
    manager,
    requests,
    inputs,
    selections,
    notices,
    errors,
    classChanges,
    hooks,
    handoff,
    dispose,
  };
}

describe("real AgentSession delivery with a memory fake provider", () => {
  it("preserves max mode for the first continuation after each class handoff", async () => {
    const h = await runtimeHarness(true);
    try {
      await h.session.prompt("/mode:max");
      assert.equal(h.session.model?.id, "max-middle-model");
      for (const [className, model] of [
        ["high", "max-high-model"],
        ["low", "max-low-model"],
        ["middle", "max-middle-model"],
      ]) {
        const before = h.requests.length;
        await h.handoff({ class: className });
        assert.equal(h.requests.length, before + 2);
        assert.equal(h.requests.at(-1)!.model, model);
        assert.match(JSON.stringify(h.requests.at(-1)!.messages), /new phase marker/);
      }
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("uses each requested class for the first continuation with the real agents receiver", async () => {
    const h = await runtimeHarness(true);
    try {
      await h.session.prompt("old user marker");
      for (const [className, model] of [
        ["high", "high-model"],
        ["low", "low-model"],
        ["middle", "fake-model"],
      ]) {
        const before = h.requests.length;
        await h.handoff({ class: className });
        assert.equal(h.requests.length, before + 2);
        assert.equal(h.requests.at(-1)!.model, model);
        assert.match(JSON.stringify(h.requests.at(-1)!.messages), /new phase marker/);
      }
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });

  it("commits the replacement after its own class change instead of cancelling it", async () => {
    const h = await runtimeHarness(true);
    try {
      await h.session.prompt("old user marker");
      await h.handoff({ class: "high" });
      const committed = h.manager.getEntries().filter(isHandoffEntry);
      assert.equal(committed.length, 1);
      assert.equal((committed[0]!.data as { count: number }).count, 1);
      assert.ok(h.manager.getEntries().some((entry) => entry.type === "context_edit"));
      const continuation = JSON.stringify(h.requests.at(-1)!.messages);
      assert.doesNotMatch(continuation, /old user marker/);
      assert.match(continuation, /new phase marker/);
      assert.ok(
        !h.notices.some((message) => message.includes("session changed while waiting")),
      );
      assert.deepEqual(h.errors, []);
    } finally {
      h.dispose();
    }
  });
  for (const delivery of ["steer", "followUp"] as const) {
    for (const source of ["interactive", "rpc", "extension"] as const) {
      it(`keeps actual ${delivery} input from ${source} after the handoff boundary`, async () => {
        const h = await runtimeHarness();
        try {
          await h.session.prompt("old user marker");
          h.manager.appendCustomEntry("handoff-session-counter", {
            type: "handoff-session-counter",
            version: 1,
            count: 2,
          });
          const start = h.requests.length;
          const queuedText = `queued ${delivery} ${source} marker`;
          h.hooks.duringTool = async (pi) => {
            h.hooks.duringTool = undefined;
            if (source === "extension") {
              const queued = Promise.withResolvers<void>();
              const unsubscribe = h.session.subscribe((event) => {
                if (
                  event.type === "queue_update" &&
                  [...event.steering, ...event.followUp].includes(queuedText)
                )
                  queued.resolve();
              });
              try {
                pi.sendUserMessage(queuedText, { deliverAs: delivery });
                await queued.promise;
              } finally {
                unsubscribe();
              }
            } else {
              assert.equal(await h.session[delivery](queuedText, undefined, { source }), "queued");
            }
          };
          await h.handoff();
          const turnRequests = h.requests.slice(start);
          assert.equal(turnRequests.length, delivery === "steer" ? 2 : 3);
          assert.match(JSON.stringify(turnRequests[0]!.messages), /old user marker/);
          for (const request of turnRequests.slice(1)) {
            const messages = JSON.stringify(request.messages);
            assert.match(messages, /new phase marker/);
            assert.doesNotMatch(
              messages,
              /old user marker|request the phase transition|Context replacement requested|tool_result|tool_use/,
            );
            assert.match(JSON.stringify(request.system), /Keep this system marker/);
            assert.ok(request.tools?.some((tool) => tool.name === "recontext"));
          }
          assert.ok(
            turnRequests
              .slice(1)
              .some((request) => JSON.stringify(request.messages).includes(queuedText)),
          );
          assert.deepEqual(h.session.getSteeringMessages(), []);
          assert.deepEqual(h.session.getFollowUpMessages(), []);
          assert.equal(h.inputs.find((event) => event.text === queuedText)?.source, source);
          assert.equal(h.selections.length, source === "extension" ? 1 : 0);
          const compactions = h.manager.getEntries().filter(isHandoffEntry);
          assert.equal(compactions.length, 1);
          assert.equal(
            (compactions[0]!.data as { count: number }).count,
            source === "extension" ? 0 : 1,
          );
          const raw = JSON.stringify(h.manager.getEntries());
          assert.match(raw, /old user marker/);
          assert.match(raw, /Context replacement requested/);
          assert.deepEqual(h.errors, []);
          assert.deepEqual(h.notices, []);
        } finally {
          h.dispose();
        }
      });
    }
  }

  it("delivers the requested class change through a real turn", async () => {
    const h = await runtimeHarness();
    try {
      await h.session.prompt("old user marker");
      await h.handoff({ class: "high" });
      assert.deepEqual(h.classChanges, [{ class: "high" }]);
      const compactions = h.manager.getEntries().filter(isHandoffEntry);
      assert.equal(compactions.length, 1);
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.notices, []);
    } finally {
      h.dispose();
    }
  });

  it("runs the two automatic handoffs and approval cycle through actual turns", async () => {
    const h = await runtimeHarness();
    try {
      await h.session.prompt("old user marker");
      for (const [index, count] of [1, 2, 0, 1, 2].entries()) {
        const start = h.requests.length;
        await h.handoff();
        assert.equal(h.requests.length - start, 2);
        const compactions = h.manager.getEntries().filter(isHandoffEntry);
        assert.equal(compactions.length, index + 1);
        assert.equal((compactions.at(-1)!.data as { count: number }).count, count);
        assert.equal(h.selections.length, index < 2 ? 0 : 1);
      }
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.notices, []);
    } finally {
      h.dispose();
    }
  });

  for (const stage of ["select", "reason"] as const) {
    for (const source of ["interactive", "rpc"] as const) {
      for (const choice of ["Yes, recontext", "No, stay (reason next)", undefined]) {
        if (stage === "reason" && choice === "Yes, recontext") continue;
        it(`resets on real ${source} input during ${stage} and stops choice ${choice}`, async () => {
          const h = await runtimeHarness();
          try {
            await h.session.prompt("old user marker");
            h.manager.appendCustomEntry("handoff-session-counter", {
              type: "handoff-session-counter",
              version: 1,
              count: 2,
            });
            async function receiveInput() {
              assert.equal(
                await h.session.steer("new user decision", undefined, { source }),
                "queued",
              );
            }
            h.hooks.duringSelect = async () => {
              if (stage === "select") await receiveInput();
              return choice;
            };
            h.hooks.duringReason = async () => {
              await receiveInput();
              return "obsolete reason";
            };
            await h.handoff();
            assert.equal(h.manager.getEntries().filter(isHandoffEntry).length, 0);
            assert.match(JSON.stringify(h.requests.at(-1)!.messages), /new user decision/);
            assert.doesNotMatch(JSON.stringify(h.requests), /no\(/);
            assert.match(h.notices[0]!, /session changed/);
            h.hooks.duringSelect = undefined;
            await h.handoff();
            const compaction = h.manager.getEntries().find(isHandoffEntry);
            assert.ok(compaction?.type === "custom");
            assert.equal((compaction.data as { count: number }).count, 1);
            assert.equal(h.selections.length, 1);
            assert.deepEqual(h.errors, []);
          } finally {
            h.dispose();
          }
        });
      }
    }
  }
});

describe("handoff input", () => {
  for (const params of [
    {},
    { reason: "x" },
    { handoff: "x" },
    { reason: 1, handoff: "x" },
    { reason: "x", handoff: null },
    { reason: " ", handoff: "x" },
    { reason: "x", handoff: "\n" },
  ]) {
    it(`rejects invalid input ${JSON.stringify(params)}`, async () => {
      const h = harness();
      const result = await h.request(params);
      assert.equal(result.isError, true);
      assert.deepEqual(h.sent, []);
    });
  }
  it("trims the payload without queuing a synthetic user message", async () => {
    const h = harness();
    const result = await h.request({ reason: " done ", handoff: " next \n" });
    assert.deepEqual(result.details, { reason: "done", handoff: "next" });
    assert.deepEqual(h.sent, []);
  });
});

describe("handoff approval cycle", () => {
  it("applies two automatic handoffs, asks on the third, then allows two again", async () => {
    const h = harness();
    for (let index = 0; index < 5; index++) {
      const result = await h.boundary();
      assert.equal(result?.continue, true);
      h.commit(result);
      assert.equal(h.selections.length, index < 2 ? 0 : 1);
    }
    assert.match(h.selections[0]!, /phase done/);
    assert.match(h.selections[0]!, /next phase/);
  });
  for (const source of ["interactive", "rpc"] as const) {
    it(`resets on ${source} input`, async () => {
      const h = harness();
      h.commit(await h.boundary());
      h.commit(await h.boundary());
      h.user(source);
      h.commit(await h.boundary());
      assert.equal(h.selections.length, 0);
    });
  }
  it("does not reset on synthetic extension input or extension reload", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.user("extension");
    const reloaded = harness(h.manager);
    reloaded.commit(await reloaded.boundary());
    assert.equal(reloaded.selections.length, 1);
  });
  it("uses the counter of the active branch after tree navigation", async () => {
    const h = harness();
    const root = h.manager.appendCustomEntry("root", {});
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.manager.branch(root);
    h.commit(await h.boundary());
    assert.equal(h.selections.length, 0);
  });
  for (const state of [
    null,
    { type: "handoff-session-counter", version: 9, count: 0 },
    { type: "handoff-session-counter", version: 1, count: -1 },
  ]) {
    it(`requires approval for invalid persisted counter ${JSON.stringify(state)}`, async () => {
      const h = harness();
      h.manager.appendCustomEntry("handoff-session-counter", state);
      h.commit(await h.boundary());
      assert.equal(h.selections.length, 1);
    });
  }
  for (const choice of ["No, stay (reason next)", undefined]) {
    it(`sends the refusal reason for choice ${choice}`, async () => {
      const h = harness();
      h.commit(await h.boundary());
      h.commit(await h.boundary());
      h.ctx.ui.select = async () => choice;
      h.ctx.ui.input = async () => "  finish tests  ";
      assert.equal(await h.boundary(), undefined);
      assert.deepEqual(h.sent, ["no(finish tests)"]);
      h.ctx.ui.select = async () => "Yes, recontext";
      const next = await h.boundary();
      const compaction = next?.entries?.find(
        (entry) => entry.type === "custom" && entry.customType === "handoff-session-counter",
      );
      assert.ok(compaction?.type === "custom");
      assert.equal((compaction.data as { count: number }).count, 0);
    });
  }
  it("uses confirm when select is unavailable and sends no() for an empty reason", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    Object.assign(h.ctx.ui, { select: undefined, confirm: async () => false });
    assert.equal(await h.boundary(), undefined);
    assert.deepEqual(h.sent, ["no()"]);
  });
  it("keeps the existing no-UI failure contract even for automatic handoffs", async () => {
    const h = harness();
    h.ctx.hasUI = false;
    assert.equal(await h.boundary(), undefined);
    assert.match(h.notices[0]!, /UI is unavailable/);
  });
});

describe("handoff class change", () => {
  it("waits for class application before returning the context boundary", async () => {
    const h = harness();
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<ClassChangeResult>();
    h.classChange.complete = () => {
      started.resolve();
      return completion.promise;
    };
    let finished = false;
    const boundary = h
      .boundary({}, { reason: "next", handoff: "next", class: "high" })
      .then((result) => {
        finished = true;
        return result;
      });
    await started.promise;
    assert.equal(finished, false);
    completion.resolve("applied");
    assert.equal((await boundary)?.continue, true);
  });

  it("reports class application errors without replacing the context", async () => {
    const h = harness();
    h.classChange.complete = () => Promise.reject(new Error("model failed"));
    assert.equal(
      await h.boundary({}, { reason: "next", handoff: "next", class: "high" }),
      undefined,
    );
    assert.match(h.notices.at(-1)!, /class change failed \(model failed\)/);
  });
  it("sends the requested class when the boundary applies the handoff", async () => {
    const h = harness();
    const result = await h.boundary(
      {},
      { reason: "phase done", handoff: "next phase", class: "high" },
    );
    assert.equal(result?.continue, true);
    assert.deepEqual(h.emitted, [
      { channel: CLASS_CHANGE_EVENT, data: { class: "high", source: "agent" } },
    ]);
  });

  it("sends no class change event when the class parameter is omitted", async () => {
    const h = harness();
    const result = await h.boundary();
    assert.equal(result?.continue, true);
    assert.deepEqual(h.emitted, []);
  });

  it("sends no class change event when the handoff is denied", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.ctx.ui.select = async () => "No, stay (reason next)";
    assert.equal(
      await h.boundary({}, { reason: "phase done", handoff: "next phase", class: "high" }),
      undefined,
    );
    assert.deepEqual(h.emitted, []);
  });

  it("rejects a blank class parameter", async () => {
    const h = harness();
    const result = await h.request({ reason: "x", handoff: "y", class: "   " });
    assert.equal(result.isError, true);
    assert.deepEqual(h.emitted, []);
  });

  it("trims the class into the stored details", async () => {
    const h = harness();
    const result = await h.request({ reason: " done ", handoff: " next ", class: " high " });
    assert.deepEqual(result.details, { reason: "done", handoff: "next", class: "high" });
  });
});

describe("handoff boundaries", () => {
  it("applies a successful handoff called through a nested tool", async () => {
    const h = harness();
    const result = await h.boundary({
      toolResults: [
        {
          role: "toolResult",
          toolName: "codemode",
          toolCallId: "outer",
          content: [],
          isError: false,
          timestamp: 1,
          nestedCalls: {
            complete: true,
            calls: [{ id: "call", name: "recontext", status: "ok", durationMs: 1 }],
          },
        },
      ],
    });
    assert.equal(result?.continue, true);
    h.commit(result);
    assert.match(JSON.stringify(h.manager.buildSessionContext().messages), /next phase/);
  });
  it("preserves prior drafts and projects messages appended after the boundary", async () => {
    const h = harness();
    const pending = { role: "user" as const, content: "do not lose this", timestamp: 1 };
    const result = await h.boundary({
      entries: [{ type: "custom", customType: "other-extension", data: 1 }],
      context: {
        contextEntries: [],
        contextMessages: [],
        llmMessages: [],
        pendingMessages: [pending],
        canContinue: true,
      },
    });
    assert.equal(result?.entries?.[0]?.type, "custom");
    h.commit(result);
    h.manager.appendMessage(pending);
    assert.match(
      JSON.stringify(convertToLlm(h.manager.buildSessionContext().messages)),
      /do not lose this/,
    );
  });
  for (const outcome of ["aborted", "error"] as const) {
    it(`does not switch or count a turn with outcome ${outcome}`, async () => {
      const h = harness();
      assert.equal(await h.boundary({ outcome }), undefined);
      h.commit(await h.boundary());
      h.commit(await h.boundary());
      assert.equal(h.selections.length, 0);
    });
  }
  it("does not switch or ask for approval if already aborted", async () => {
    const h = harness();
    h.controller.abort();
    assert.equal(await h.boundary(), undefined);
    assert.deepEqual(h.selections, []);
  });
  it("does not switch after abort during approval", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.ctx.ui.select = async () => {
      h.controller.abort();
      return "Yes, recontext";
    };
    assert.equal(await h.boundary(), undefined);
  });
  it("keeps new user input received during approval", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.ctx.ui.select = async () => {
      h.user();
      h.manager.appendMessage({ role: "user", content: "new decision", timestamp: 1 });
      return "Yes, recontext";
    };
    assert.equal(await h.boundary(), undefined);
    assert.match(JSON.stringify(h.manager.buildSessionContext().messages), /new decision/);
  });
  it("does not switch after confirmation throws", async () => {
    const h = harness();
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    h.ctx.ui.select = async () => {
      throw new Error("dialog failed");
    };
    assert.equal(await h.boundary(), undefined);
    assert.match(h.notices[0]!, /dialog failed/);
  });
  it("rejects multiple handoffs and failed sibling tools without advancing the counter", async () => {
    const h = harness();
    const result = await h.request();
    const request = {
      role: "toolResult" as const,
      toolName: "recontext",
      toolCallId: "x",
      content: result.content,
      details: result.details as TurnEndEvent["toolResults"][number]["details"],
      isError: false,
      timestamp: 1,
    };
    assert.equal(
      await h.boundary({ toolResults: [request, { ...request, toolCallId: "y" }] }),
      undefined,
    );
    assert.equal(
      await h.boundary({ toolResults: [request, { ...request, toolName: "bash", isError: true }] }),
      undefined,
    );
    h.commit(await h.boundary());
    h.commit(await h.boundary());
    assert.equal(h.selections.length, 0);
  });
});

describe("handoff safety while awaiting UI", () => {
  for (const dialog of ["select", "confirm", "reason"] as const) {
    for (const change of ["leaf", "session", "abort"] as const) {
      for (const choice of ["Yes, recontext", "No, stay (reason next)", undefined]) {
        if (dialog === "reason" && choice === "Yes, recontext") continue;
        it(`stops after ${change} changes during ${dialog} with choice ${choice}`, async () => {
          const h = harness();
          h.commit(await h.boundary());
          h.commit(await h.boundary());
          const originalCompactions = h.manager.getEntries().filter(isHandoffEntry);
          const counterLeaf = h.manager.getLeafId()!;
          const waiting = Promise.withResolvers<void>();
          const response = Promise.withResolvers<void>();
          let reasonPrompts = 0;
          async function decision() {
            waiting.resolve();
            await response.promise;
            return choice;
          }
          h.ctx.ui.input = async () => {
            reasonPrompts++;
            if (dialog === "reason") {
              waiting.resolve();
              await response.promise;
            }
            return "obsolete reason";
          };
          if (dialog === "confirm") {
            Object.assign(h.ctx.ui, { select: undefined });
            h.ctx.ui.confirm = async () => (await decision()) === "Yes, recontext";
          } else if (dialog === "select") {
            h.ctx.ui.select = decision;
          } else {
            h.ctx.ui.select = async () => choice;
          }
          const pending = h.boundary();
          await waiting.promise;
          if (change === "leaf") h.manager.branch(counterLeaf);
          if (change === "session") {
            h.manager.newSession();
            h.manager.appendCustomEntry("handoff-session-counter", {
              type: "handoff-session-counter",
              version: 1,
              count: 2,
            });
          }
          if (change === "abort") h.controller.abort();
          const entriesAfterChange = h.manager.getEntries();
          response.resolve();
          assert.equal(await pending, undefined);
          assert.deepEqual(h.sent, []);
          assert.deepEqual(h.manager.getEntries(), entriesAfterChange);
          assert.equal(reasonPrompts, dialog === "reason" ? 1 : 0);
          if (change !== "abort") {
            assert.match(h.notices[0]!, /session changed/);
            h.ctx.ui.select = async () => "Yes, recontext";
            const next = await h.boundary();
            const compaction = next?.entries?.find(
              (entry) => entry.type === "custom" && entry.customType === "handoff-session-counter",
            );
            assert.ok(compaction?.type === "custom");
            assert.equal((compaction.data as { count: number }).count, 0);
          } else {
            assert.deepEqual(h.manager.getEntries().filter(isHandoffEntry), originalCompactions);
          }
        });
      }
    }
  }
});

describe("nested handoff safety", () => {
  for (const condition of [
    "incomplete",
    "error",
    "unfinished",
    "multiple",
    "direct-and-nested",
  ] as const) {
    it(`keeps context and counter for ${condition} nested calls`, async () => {
      const h = harness();
      h.commit(await h.boundary());
      const before = h.manager.getEntries().filter(isHandoffEntry);
      await h.request(undefined, "second");
      const nested: TurnEndEvent["toolResults"][number] = {
        role: "toolResult",
        toolName: "outer",
        toolCallId: "outer",
        content: [],
        isError: false,
        timestamp: 1,
        nestedCalls: {
          complete: condition !== "incomplete",
          calls: [
            {
              id: "call",
              name: "recontext",
              status: condition === "error" || condition === "unfinished" ? condition : "ok",
              durationMs: 1,
            },
          ],
        },
      };
      if (condition === "multiple")
        nested.nestedCalls!.calls.push({
          id: "second",
          name: "recontext",
          status: "ok",
          durationMs: 1,
        });
      const results = [nested];
      if (condition === "direct-and-nested")
        results.push({
          ...nested,
          toolName: "recontext",
          toolCallId: "direct",
          nestedCalls: undefined,
          details: { reason: "done", handoff: "other phase" },
        });
      assert.equal(await h.boundary({ toolResults: results }), undefined);
      assert.deepEqual(h.manager.getEntries().filter(isHandoffEntry), before);
      assert.deepEqual(h.sent, []);
      const next = await h.boundary();
      const compaction = next?.entries?.find(
        (entry) => entry.type === "custom" && entry.customType === "handoff-session-counter",
      );
      assert.ok(compaction?.type === "custom");
      assert.equal((compaction.data as { count: number }).count, 2);
      assert.deepEqual(h.selections, []);
    });
  }
});

describe("persisted session context", () => {
  it("replaces a prior immutable summary without a raw user anchor or a new compaction", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: "KEEP SYSTEM", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "old raw text", timestamp: 2 });
    const legacyId = manager.appendCompaction("LEGACY SUMMARY", null, 1);
    const legacy = structuredClone(manager.getEntry(legacyId));
    const h = harness(manager);
    const boundary = await h.boundary({}, { reason: "next", handoff: "  EXACT HANDOFF  " });
    assert.equal(boundary?.continue, true);
    h.commit(boundary);
    const model = convertToLlm(
      projectPendingMessages(manager.buildSessionProjection().messages, manager),
    );
    assert.match(JSON.stringify(model), /EXACT HANDOFF/);
    assert.doesNotMatch(
      JSON.stringify(model),
      /LEGACY SUMMARY|old raw text|Context replacement requested/,
    );
    assert.match(JSON.stringify(model), /KEEP SYSTEM/);
    assert.deepEqual(manager.getEntry(legacyId), legacy);
    assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(
      manager.getBranch().filter((entry) => entry.type === "custom_message" && !entry.display)
        .length,
      1,
    );
    assert.deepEqual(h.notices, []);
  });

  it("keeps raw history and system/tools, excludes old messages, and preserves the counter on resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recontext-"));
    try {
      const manager = SessionManager.create(directory, directory);
      manager.appendMessage({
        role: "system",
        content: "keep these instructions",
        toolsAdded: [{ name: "read", description: "read files", parameters: {} }],
        timestamp: 1,
      });
      manager.appendMessage({ role: "user", content: "old user history", timestamp: 2 });
      const h = harness(manager);
      const file = manager.getSessionFile()!;
      const sessionId = manager.getSessionId();
      h.commit(await h.boundary());
      h.commit(await h.boundary());
      const raw = readFileSync(file, "utf8");
      assert.match(raw, /old user history/);
      assert.match(raw, /toolResult/);
      const llm = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
      assert.doesNotMatch(llm, /old user history|Context replacement requested|toolResult/);
      assert.match(llm, /next phase/);
      assert.match(llm, /keep these instructions/);
      assert.match(llm, /read files/);
      const resumed = harness(SessionManager.open(file));
      assert.equal(resumed.manager.getSessionId(), sessionId);
      assert.equal(resumed.manager.getSessionFile(), file);
      resumed.commit(await resumed.boundary());
      assert.equal(resumed.selections.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("tool rendering", () => {
  initTheme("dark", false);
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
    }),
  );

  const plainTheme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
  };

  function renderContext(state: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return {
      args: {},
      toolCallId: "call",
      invalidate: () => {},
      lastComponent: undefined,
      state,
      cwd: "/tmp",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      ...overrides,
    } as never;
  }

  function okResult() {
    return {
      content: [
        { type: "text" as const, text: "Context replacement requested for the end of this turn." },
      ],
      details: { reason: "phase done", handoff: "next phase" },
    } as never;
  }

  function renderedText(component: { render(width: number): string[] }): string {
    return component.render(80).join("\n");
  }

  function toolBlock(h: ReturnType<typeof harness>, state: Record<string, unknown>) {
    return renderersOf("recontext")!.renderCall!({}, plainTheme as never, renderContext(state));
  }

  function renderers() {
    return renderersOf("recontext")!;
  }

  it("renders the label and a requesting line while the call is pending", () => {
    const h = harness();
    const pending = renderedText(toolBlock(h, {}));
    assert.match(pending, /\[compaction\]/);
    assert.match(pending, /Requesting context replacement\.\.\./);
  });

  it("renders the collapsed one-line result in the same block as the label", () => {
    const h = harness();
    const state = {};
    const block = toolBlock(h, state);
    const result = renderers().renderResult!(
      okResult(),
      { expanded: false, isPartial: false },
      plainTheme as never,
      renderContext(state),
    );
    const combined = `${renderedText(block)}\n${renderedText(result)}`;
    assert.match(combined, /Context will be replaced at end of turn \(ctrl\+o to expand\)/);
  });

  it("renders the label once across the call and result components", () => {
    const h = harness();
    const state = {};
    const block = toolBlock(h, state);
    const result = renderers().renderResult!(
      okResult(),
      { expanded: false, isPartial: false },
      plainTheme as never,
      renderContext(state),
    );
    const combined = `${renderedText(block)}\n${renderedText(result)}`;
    assert.equal(combined.split("[compaction]").length - 1, 1);
  });

  it("renders reason and handoff as markdown when expanded", () => {
    const h = harness();
    const state = {};
    const block = toolBlock(h, state);
    renderers().renderResult!(
      okResult(),
      { expanded: true, isPartial: false },
      plainTheme as never,
      renderContext(state),
    );
    const expanded = renderedText(block);
    assert.match(expanded, /Reason/);
    assert.match(expanded, /phase done/);
    assert.match(expanded, /Handoff/);
    assert.match(expanded, /next phase/);
  });

  it("renders the tool error message on error results", () => {
    const h = harness();
    const state = {};
    const block = toolBlock(h, state);
    renderers().renderResult!(
      {
        content: [
          { type: "text" as const, text: "Both reason and handoff must be non-empty strings." },
        ],
        details: undefined,
      } as never,
      { expanded: false, isPartial: false },
      plainTheme as never,
      renderContext(state, { isError: true }),
    );
    assert.match(renderedText(block), /Both reason and handoff must be non-empty strings\./);
  });
});

function memoryCredentials() {
  const values = new Map<string, Credential>();
  return {
    async read(id: string) {
      return values.get(id);
    },
    async list() {
      return [...values].map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    async modify(
      id: string,
      update: (
        value: Credential | undefined,
      ) => Credential | undefined | Promise<Credential | undefined>,
    ) {
      const value = await update(values.get(id));
      if (value) values.set(id, value);
      else values.delete(id);
      return value;
    },
    async delete(id: string) {
      values.delete(id);
    },
  };
}
