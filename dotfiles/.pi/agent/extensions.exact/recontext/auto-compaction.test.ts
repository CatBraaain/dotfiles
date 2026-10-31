import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "bun:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  normalizeContext,
  hasApi,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Api,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  compactionCandidates,
  estimateInput,
  outputBudget,
  requestFits,
  SUMMARY_INSTRUCTION,
  summaryRequestOptions,
} from "./auto-compaction.ts";
import * as responsesAdapter from "@earendil-works/pi-ai/api/openai-responses";
import * as azureAdapter from "@earendil-works/pi-ai/api/azure-openai-responses";
import * as completionsAdapter from "@earendil-works/pi-ai/api/openai-completions";
import * as anthropicAdapter from "@earendil-works/pi-ai/api/anthropic-messages";
import { assistant, fakeModel, seedConversation } from "./test-fixture.ts";

function candidates(manager: SessionManager, contextWindow = 12_000) {
  const projection = manager.buildSessionProjection();
  return compactionCandidates(
    manager,
    projection.entries,
    fakeModel({ contextWindow }),
    normalizeContext({ messages: convertToLlm(projection.messages) }),
    {},
  );
}

function exchange(manager: SessionManager, label: string, chars: number, timestamp: number) {
  const id = manager.appendMessage({ role: "user", content: label + "x".repeat(chars), timestamp });
  manager.appendMessage(assistant(undefined, label + "a".repeat(chars), "stop", timestamp + 1));
  return id;
}

describe("effective request budgets", () => {
  it("uses the dispatched model window and output reservation without a fixed trigger ratio", () => {
    const context = normalizeContext({
      messages: [{ role: "user" as const, content: "x".repeat(3_500), timestamp: 1 }],
    });
    const model = fakeModel({ contextWindow: 6_096, maxTokens: 1_000 });
    assert.equal(requestFits(model, context, {}), true);
    assert.equal(requestFits({ ...model, contextWindow: 6_095 }, context, {}), false);
    assert.equal(
      requestFits({ ...model, contextWindow: 5_596 }, context, { maxTokens: 500 }),
      true,
    );
  });

  it("does not reuse provider usage recorded before projection edits", () => {
    const reply = assistant(undefined, "x".repeat(35_000));
    reply.usage = { ...reply.usage, input: 1, output: 1, totalTokens: 2 };
    assert.equal(estimateInput([reply]), 10_000);
    assert.equal(requestFits(fakeModel(), normalizeContext({ messages: [reply] }), {}), false);
  });

  it("includes image estimates and system/tool declaration updates", () => {
    const base: Message[] = [
      {
        role: "system",
        content: "instructions",
        toolsAdded: [{ name: "read", description: "r", parameters: { type: "object" } }],
        timestamp: 1,
      },
    ];
    const expanded: Message[] = [
      ...base,
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "opaque" }],
        timestamp: 2,
      },
      { role: "system", content: "updated", toolsRemoved: [{ name: "read" }], timestamp: 3 },
    ];
    assert.ok(estimateInput(expanded) > estimateInput(base) + 1_300);
  });

  it("reserves token-based thinking and sampling output overrides", () => {
    const model = fakeModel({ api: "anthropic-messages", reasoning: true, maxTokens: 20_000 });
    assert.equal(outputBudget(model, { reasoning: "low", maxTokens: 1_000 }), 3_048);
    assert.equal(outputBudget(model, { reasoning: "low", maxTokens: 1_000 }, false), 1_000);
    assert.equal(outputBudget(model, { samplingParams: { max_output_tokens: 25_000 } }), 20_000);
    assert.throws(
      () => requestFits({ ...model, contextWindow: 0 }, normalizeContext({ messages: [] }), {}),
      /budget/,
    );
  });
});

describe("adapter output limits", () => {
  const apis = [
    ["openai-responses", "max_output_tokens"],
    ["azure-openai-responses", "max_output_tokens"],
    ["openai-completions", "max_completion_tokens"],
  ] as const;

  for (const [api, field] of apis) {
    for (const simple of [true, false]) {
      it(`${api} ${simple ? "simple" : "raw"} applies model, thinking, and request caps in adapter order`, () => {
        const model = fakeModel({
          api,
          reasoning: true,
          maxTokens: 10_000,
          samplingParams: { [field]: 1_000 },
        });
        assert.equal(outputBudget(model, {}, simple), 1_000);
        model.samplingParamsByThinkingLevel = { low: { [field]: 700 }, high: { [field]: 800 } };
        const options = simple
          ? { reasoning: "low" as const, reasoningEffort: "high" as const }
          : { reasoningEffort: "low" as const, reasoning: "high" as const };
        assert.equal(outputBudget(model, options, simple), 700);
        assert.equal(
          outputBudget(
            model,
            { ...options, maxTokens: 10_000, samplingParams: { [field]: 400 } },
            simple,
          ),
          400,
        );
        assert.equal(
          outputBudget(
            model,
            { ...options, maxTokens: 500, samplingParams: { [field]: 25_000 } },
            simple,
          ),
          25_000,
        );
        const clamped = simple
          ? { reasoning: "xhigh" as const }
          : { reasoningEffort: "xhigh" as const };
        assert.equal(outputBudget(model, clamped, simple), 800);
        const summary = summaryRequestOptions(model, options, 600, simple);
        assert.equal(outputBudget(model, summary, simple), 600);
        assert.equal(summary.samplingParams?.[field], 600);
      });
    }
  }

  it("uses raw reasoningEffort or reasoningSummary rather than the simple reasoning option", () => {
    const model = fakeModel({
      reasoning: true,
      maxTokens: 10_000,
      samplingParamsByThinkingLevel: {
        off: { max_output_tokens: 900 },
        low: { max_output_tokens: 700 },
        medium: { max_output_tokens: 500 },
      },
    });
    assert.equal(outputBudget(model, { reasoning: "low" }, false), 900);
    assert.equal(outputBudget(model, { reasoningSummary: "auto" }, false), 500);
    assert.equal(
      outputBudget(model, { reasoningEffort: "low", reasoningSummary: "auto" }, false),
      700,
    );
    model.thinkingLevelMap = { low: null };
    assert.equal(outputBudget(model, { reasoning: "low" }), 500);
  });

  it("respects the completions field selected by compat and keeps conflicting wire caps conservative", () => {
    const model = fakeModel({
      api: "openai-completions",
      maxTokens: 10_000,
      compat: { maxTokensField: "max_tokens" },
      samplingParams: { max_tokens: 500 },
    });
    assert.equal(outputBudget(model, {}), 500);
    assert.equal(outputBudget(model, {}, false), 500);
    model.samplingParams = { max_completion_tokens: 500 };
    assert.equal(outputBudget(model, {}), 10_000);
    assert.equal(outputBudget(model, {}, false), 500);
    assert.equal(outputBudget(model, { maxTokens: 2_000 }, false), 2_000);
  });

  it("matches the adapter legacy completions field defaults", () => {
    const providers = [
      "deepseek",
      "moonshotai",
      "moonshotai-cn",
      "cloudflare-ai-gateway",
      "together",
      "nvidia",
      "ant-ling",
      "zai",
      "zai-coding-cn",
    ];
    const urls = [
      "chutes.ai",
      "api.deepseek.com",
      "api.moonshot.cn",
      "gateway.ai.cloudflare.com",
      "api.together.ai",
      "api.together.xyz",
      "integrate.api.nvidia.com",
      "api.ant-ling.com",
      "api.z.ai",
      "open.bigmodel.cn",
    ];
    for (const provider of providers) {
      const model = fakeModel({
        api: "openai-completions",
        provider,
        maxTokens: 10_000,
        samplingParams: { max_tokens: 500 },
      });
      assert.equal(outputBudget(model, {}), 500, provider);
    }
    for (const url of urls) {
      const model = fakeModel({
        api: "openai-completions",
        baseUrl: `https://${url}/v1`,
        maxTokens: 10_000,
        samplingParams: { max_tokens: 500 },
      });
      assert.equal(outputBudget(model, {}), 500, url);
    }
  });

  for (const api of [
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-vertex",
    "mistral-conversations",
    "pi-messages",
  ] as const) {
    it(`${api} ignores sampling keys that its public adapter does not apply`, () => {
      const model = fakeModel({
        api,
        maxTokens: 10_000,
        samplingParams: { max_output_tokens: 25_000, max_tokens: 300 },
      });
      assert.equal(outputBudget(model, { maxTokens: 1_000 }), 1_000);
      assert.equal(outputBudget(model, { maxTokens: 1_000 }, false), 1_000);
    });
  }

  it("does not add a token thinking budget to adaptive Anthropic or Bedrock and non-Claude Bedrock requests", () => {
    const options = {
      reasoning: "low" as const,
      maxTokens: 1_000,
      thinkingBudgets: { low: 4_000 },
    };
    const anthropic = fakeModel({
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 20_000,
      compat: { forceAdaptiveThinking: true },
    });
    assert.equal(outputBudget(anthropic, options), 1_000);
    const bedrock = fakeModel({
      api: "bedrock-converse-stream",
      reasoning: true,
      maxTokens: 20_000,
      id: "anthropic.claude-3-7-sonnet",
      name: "Claude 3.7",
    });
    assert.equal(outputBudget(bedrock, options), 5_000);
    assert.equal(outputBudget(bedrock, options, false), 1_000);
    for (const name of [
      "Claude Opus 4.6",
      "Claude Opus 4.7",
      "Claude Opus 4.8",
      "Claude Opus 5",
      "Claude Sonnet 4.6",
      "Claude Sonnet 5",
      "Claude Haiku 5",
      "Claude Fable 5",
    ]) {
      assert.equal(
        outputBudget({ ...bedrock, id: "inference-profile", name }, options),
        1_000,
        name,
      );
    }
    assert.equal(outputBudget({ ...bedrock, id: "mistral", name: "Mistral" }, options), 1_000);
  });

  it("reserves the model ceiling when Codex does not send output caps", () => {
    const model = fakeModel({
      api: "openai-codex-responses",
      maxTokens: 20_000,
      samplingParams: { max_output_tokens: 500 },
    });
    assert.equal(outputBudget(model, { maxTokens: 1_000 }), 20_000);
    assert.equal(outputBudget(model, { maxTokens: 1_000 }, false), 20_000);
  });

  it("accounts for the Responses minimum and does not invent a cap when compat omits it", () => {
    for (const api of ["openai-responses", "azure-openai-responses"] as const) {
      const model = fakeModel({ api, maxTokens: 10_000 });
      assert.equal(outputBudget(model, { maxTokens: 1 }), 16);
      assert.equal(outputBudget(model, { maxTokens: 1 }, false), 16);
      const summary = summaryRequestOptions(
        { ...model, samplingParams: { max_output_tokens: 1_000 } },
        {},
        1,
      );
      assert.equal(summary.maxTokens, 16);
      assert.equal(summary.samplingParams?.max_output_tokens, 16);
      assert.equal(outputBudget(model, summary), 16);
    }
    const model = fakeModel({ maxTokens: 10_000, compat: { supportsMaxOutputTokens: false } });
    assert.equal(outputBudget(model, { maxTokens: 500 }), 10_000);
    assert.equal(outputBudget(model, { samplingParams: { max_output_tokens: 500 } }), 500);
  });

  it("keeps unknown APIs gated conservatively without claiming new wire semantics", () => {
    const model = fakeModel({ api: "unknown-public-adapter" as Api, maxTokens: 10_000 });
    assert.equal(outputBudget(model, { samplingParams: { max_tokens: 500 } }), 10_000);
    assert.equal(outputBudget(model, { samplingParams: { max_tokens: 25_000 } }), 25_000);
  });

  it("reserves the model ceiling when sampling clears the named cap", () => {
    for (const value of [null, undefined]) {
      const model = fakeModel({ maxTokens: 10_000, samplingParams: { max_output_tokens: value } });
      assert.equal(outputBudget(model, { maxTokens: 500 }), 10_000);
      assert.equal(outputBudget(model, { maxTokens: 500 }, false), 10_000);
    }
    assert.equal(outputBudget(fakeModel({ maxTokens: 10_000 }), { maxTokens: 0 }), 10_000);
  });

  it("fails closed on unusable effective output values", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
      assert.throws(
        () => outputBudget(fakeModel({ samplingParams: { max_output_tokens: value } }), {}),
        /budget/,
      );
    }
  });
});

describe("native adapter output payloads without networking", () => {
  for (const [api, adapter, field] of [
    ["openai-responses", responsesAdapter, "max_output_tokens"],
    ["azure-openai-responses", azureAdapter, "max_output_tokens"],
    ["openai-completions", completionsAdapter, "max_completion_tokens"],
  ] as const) {
    for (const simple of [true, false]) {
      it(`${api} ${simple ? "simple" : "raw"} emits the effective lower sampling cap`, async () => {
        const model = fakeModel({
          api,
          maxTokens: 10_000,
          contextWindow: 16_000,
          reasoning: true,
          samplingParams: { [field]: 3_000 },
          samplingParamsByThinkingLevel: { low: { [field]: 2_000 } },
        });
        const context = normalizeContext({
          messages: [{ role: "user", content: "x".repeat(14_000), timestamp: 1 }],
        });
        const bodies: Record<string, unknown>[] = [];
        const fetch = (async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response('{"error":{"message":"synthetic","type":"invalid_request_error"}}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof globalThis.fetch;
        const options = {
          apiKey: "sk-synthetic",
          maxTokens: 10_000,
          ...(simple ? { reasoning: "low" as const } : { reasoningEffort: "low" as const }),
          samplingParams: { [field]: 1_000 },
          fetch,
          maxRetries: 0,
          transport: "auto" as const,
        };
        const streams = adapter as unknown as ProviderStreams;
        const result = await (
          simple
            ? streams.streamSimple(model, context, options)
            : streams.stream(model, context, options)
        ).result();
        assert.equal(result.stopReason, "error");
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0]![field], 1_000);
        assert.equal(outputBudget(model, options, simple), bodies[0]![field]);
        assert.equal(requestFits(model, context, options, simple), true);
      });
    }
  }

  for (const adaptive of [false, true]) {
    for (const simple of [true, false]) {
      it(`matches Anthropic ${adaptive ? "adaptive" : "legacy"} ${simple ? "simple" : "raw"} output without charging an extra adaptive budget`, async () => {
        const model = fakeModel({
          api: "anthropic-messages",
          reasoning: true,
          maxTokens: 20_000,
          contextWindow: 40_000,
          compat: { forceAdaptiveThinking: adaptive },
        });
        const context = normalizeContext({
          messages: [{ role: "user", content: "request", timestamp: 1 }],
        });
        const bodies: Record<string, unknown>[] = [];
        const options = {
          apiKey: "sk-synthetic",
          maxTokens: 1_000,
          reasoning: "low" as const,
          maxRetries: 0,
          fetch: (async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(
              '{"type":"error","error":{"type":"invalid_request_error","message":"synthetic"}}',
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }) as typeof globalThis.fetch,
        };
        assert.ok(hasApi(model, "anthropic-messages"));
        const result = await (
          simple
            ? anthropicAdapter.streamSimple(model, context, options)
            : anthropicAdapter.stream(model, context, options)
        ).result();
        assert.equal(result.stopReason, "error");
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0]!.max_tokens, adaptive || !simple ? 1_000 : 3_048);
        assert.equal(outputBudget(model, options, simple), bodies[0]!.max_tokens);
      });
    }
  }

  it("matches the Responses named-field minimum and synthetic sign-in omission", async () => {
    for (const apiKey of ["sk-synthetic", "synthetic-sign-in"]) {
      const model = fakeModel({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 40_000,
        maxTokens: 10_000,
      });
      const bodies: Record<string, unknown>[] = [];
      const options = {
        apiKey,
        maxTokens: 1,
        maxRetries: 0,
        fetch: (async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response('{"error":{"message":"synthetic"}}', {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof globalThis.fetch,
      };
      assert.ok(hasApi(model, "openai-responses"));
      await responsesAdapter
        .streamSimple(
          model,
          normalizeContext({ messages: [{ role: "user", content: "request", timestamp: 1 }] }),
          options,
        )
        .result();
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]!.max_output_tokens, apiKey.startsWith("sk-") ? 16 : undefined);
      assert.equal(outputBudget(model, options), apiKey.startsWith("sk-") ? 16 : 10_000);
    }
  });
});

describe("finite verbatim retention", () => {
  it("starts with the latest complete exchange and retains the current incomplete suffix", () => {
    const manager = SessionManager.inMemory();
    const ids = seedConversation(manager, 12_500);
    const available = candidates(manager);
    assert.equal(available[0]?.keptExchanges, 1);
    assert.ok(available[0]!.targetIds.has(ids.old));
    assert.equal(available[0]!.targetIds.has(ids.recent), false);
    assert.equal(available[0]!.targetIds.has(ids.pending), false);
    assert.equal(available[0]!.summaryContext.messages.at(-1)?.content, SUMMARY_INSTRUCTION);
  });

  it("expands retention from one exchange to two when the shorter old prefix fits", () => {
    const manager = SessionManager.inMemory();
    exchange(manager, "old", 7_000, 1);
    const middle = exchange(manager, "middle", 10_000, 3);
    exchange(manager, "recent", 1_000, 5);
    manager.appendMessage({ role: "user", content: "new", timestamp: 7 });
    const available = candidates(manager);
    assert.equal(available[0]?.keptExchanges, 2);
    assert.equal(available[0]!.targetIds.has(middle), false);
    assert.ok(available.length <= 3);
  });

  it("rejects a smaller summary prefix when verbatim retention makes the normal request too large", () => {
    const manager = SessionManager.inMemory();
    exchange(manager, "old", 1_000, 1);
    exchange(manager, "recent", 18_000, 3);
    manager.appendMessage({ role: "user", content: "new", timestamp: 5 });
    assert.deepEqual(candidates(manager), []);
  });

  it("keeps parallel calls, all results, and the following response in one exchange", () => {
    const manager = SessionManager.inMemory();
    exchange(manager, "old", 6_000, 1);
    const toolUser = manager.appendMessage({ role: "user", content: "tools", timestamp: 3 });
    const call = assistant(undefined, "", "toolUse", 4);
    call.content = ["one", "two"].map((id) => ({
      type: "toolCall",
      id,
      name: "read",
      arguments: {},
    }));
    const callId = manager.appendMessage(call);
    const resultIds = ["two", "one"].map((toolCallId, index) =>
      manager.appendMessage({
        role: "toolResult",
        toolName: "read",
        toolCallId,
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 5 + index,
      }),
    );
    const replyId = manager.appendMessage(assistant(undefined, "finished tools", "stop", 7));
    manager.appendMessage({ role: "user", content: "new unfinished request", timestamp: 8 });
    const candidate = candidates(manager)[0]!;
    for (const id of [toolUser, callId, ...resultIds, replyId])
      assert.equal(candidate.targetIds.has(id), false);
  });

  it("does not cut an unresolved tool batch at a later user message", () => {
    const manager = SessionManager.inMemory();
    exchange(manager, "old", 6_000, 1);
    const call = assistant(undefined, "", "toolUse", 4);
    call.content = [{ type: "toolCall", id: "missing", name: "read", arguments: {} }];
    manager.appendMessage({ role: "user", content: "unfinished tools", timestamp: 3 });
    manager.appendMessage(call);
    exchange(manager, "newer", 100, 5);
    manager.appendMessage({ role: "user", content: "current", timestamp: 7 });
    const available = candidates(manager);
    assert.equal(
      available.some((candidate) => candidate.targetIds.has(manager.getBranch()[2]!.id)),
      false,
    );
  });

  it("preserves the exact structured prefix and the effective later system/tool state", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 12_500);
    manager.appendMessage({
      role: "system",
      content: "later rules",
      sections: { policy: "new policy" },
      toolsAdded: [{ name: "new_tool", description: "n", parameters: {} }],
      toolsRemoved: [{ name: "old_tool" }],
      timestamp: 7,
    });
    const normal = convertToLlm(manager.buildSessionProjection().messages);
    const candidate = candidates(manager)[0]!;
    assert.deepEqual(candidate.summaryContext.messages.slice(0, 3), normal.slice(0, 3));
    assert.strictEqual(candidate.summaryContext.messages[2], normal[2]);
    assert.equal(
      getCurrentSystemPrompt(candidate.summaryContext.messages),
      getCurrentSystemPrompt(normal),
    );
    assert.deepEqual(getCurrentTools(candidate.summaryContext.messages), getCurrentTools(normal));
  });

  it("refuses a candidate below the adapter output minimum and accepts the exact minimum", () => {
    const manager = SessionManager.inMemory();
    seedConversation(manager, 7_000);
    const projection = manager.buildSessionProjection();
    const context = normalizeContext({ messages: convertToLlm(projection.messages) });
    const model = fakeModel();
    const first = compactionCandidates(manager, projection.entries, model, context, {})[0]!;
    const required = estimateInput(first.summaryContext.messages) + 4_096;
    assert.deepEqual(
      compactionCandidates(
        manager,
        projection.entries,
        { ...model, contextWindow: required + 15 },
        context,
        {},
      ),
      [],
    );
    const exact = compactionCandidates(
      manager,
      projection.entries,
      { ...model, contextWindow: required + 16 },
      context,
      {},
    )[0]!;
    assert.equal(exact.maxTokens, 16);
  });

  it("leaves an initial oversized user message unchanged when no complete exchange exists", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "x".repeat(100_000), timestamp: 1 });
    assert.deepEqual(candidates(manager), []);
    assert.equal(manager.getEntries().length, 1);
  });
});

describe("summary instruction specification", () => {
  it("matches the summary instruction in the specification exactly", () => {
    const spec = readFileSync(new URL("./SPEC.md", import.meta.url), "utf8");
    const sectionHeading = "## 自動圧縮プロンプト\n";
    const sectionStart = spec.indexOf(sectionHeading);
    assert.notEqual(sectionStart, -1);
    assert.equal(spec.indexOf(sectionHeading, sectionStart + sectionHeading.length), -1);

    const nextSectionStart = spec.indexOf("\n## ", sectionStart + sectionHeading.length);
    const section = spec.slice(
      sectionStart,
      nextSectionStart === -1 ? spec.length : nextSectionStart,
    );
    const openingFence = "```text\n";
    const openingFenceStart = section.indexOf(openingFence);
    assert.notEqual(openingFenceStart, -1);
    assert.equal(section.indexOf(openingFence, openingFenceStart + openingFence.length), -1);

    const instructionStart = openingFenceStart + openingFence.length;
    const closingFence = "\n```";
    const closingFenceStart = section.indexOf(closingFence, instructionStart);
    assert.notEqual(closingFenceStart, -1);
    assert.equal(section.indexOf(closingFence, closingFenceStart + closingFence.length), -1);

    const specificationInstruction = section.slice(instructionStart, closingFenceStart);
    assert.equal(specificationInstruction, SUMMARY_INSTRUCTION);
  });
});
