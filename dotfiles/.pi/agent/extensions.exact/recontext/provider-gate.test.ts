import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Api } from "@earendil-works/pi-ai";
import {
  AUTO_COMPACTION_REQUEST,
  installProviderGates,
  type AutoCompactionRequest,
} from "./provider-gate.ts";
import { pendingProjection, REPLACEMENT_STATE } from "./projection.ts";
import {
  SUMMARY_INSTRUCTION,
  outputBudget,
  requestFits,
  type CompactionOptions,
} from "./auto-compaction.ts";
import { commitDrafts, fakeProvider, gateFixture, seedConversation } from "./test-fixture.ts";

async function send(
  h: Awaited<ReturnType<typeof gateFixture>>,
  options: Omit<CompactionOptions, "toolChoice"> = {},
  simple = true,
) {
  const context = normalizeContext({
    messages: convertToLlm(h.manager.buildSessionProjection().messages),
  });
  const effective = { sessionId: h.manager.getSessionId(), ...options };
  const stream = simple
    ? h.registry.streamSimple(h.model, context, effective)
    : h.registry.stream(h.model, context, effective);
  return stream.result();
}

function states(h: Awaited<ReturnType<typeof gateFixture>>) {
  return h.manager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === REPLACEMENT_STATE);
}

describe("final provider preflight", () => {
  it("forks the captured physical model and exact prefix, isolates callbacks, then sends the compressed request", async () => {
    const h = await gateFixture();
    try {
      const ids = seedConversation(h.manager, 10_000);
      const oldUser = h.manager.getEntry(ids.old);
      assert.ok(oldUser?.type === "message" && oldUser.message.role === "user");
      oldUser.message.content = [
        { type: "text", text: "OLD " + "x".repeat(10_000) },
        { type: "image", data: "opaque-image-data", mimeType: "image/png" },
      ];
      const oldAssistant = h.manager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "assistant");
      assert.ok(oldAssistant?.type === "message" && oldAssistant.message.role === "assistant");
      oldAssistant.message.content.push({
        type: "thinking",
        thinking: "retained thought",
        thinkingSignature: "opaque-signature",
      });
      const normalContext = { messages: convertToLlm(h.manager.buildSessionProjection().messages) };
      const callbackKinds: string[] = [];
      const options = {
        sessionId: h.manager.getSessionId(),
        apiKey: "resolved-request-key",
        headers: { "X-Request": "keep" },
        env: { SYNTHETIC: "keep" },
        transport: "websocket" as const,
        cacheRetention: "long" as const,
        identity: { name: "test-client", version: "1" },
        metadata: { affinity: "keep" },
        timeoutMs: 1_000,
        maxRetryDelayMs: 42,
        maxRetries: 0,
        onPayload(payload: unknown) {
          callbackKinds.push(`payload:${(payload as { kind: string }).kind}`);
        },
        onResponse(response: { status: number }) {
          callbackKinds.push(`response:${response.status}`);
        },
        onProviderStreamEvent(data: unknown) {
          callbackKinds.push(`stream:${(data as { kind: string }).kind}`);
        },
      };
      const result = await h.registry.streamSimple(h.model, normalContext, options).result();
      assert.equal(result.stopReason, "stop");
      const [summary, normal] = h.state.requests;
      assert.deepEqual(h.state.timeline, [
        "summary:start",
        "summary:end",
        "normal:start",
        "normal:end",
      ]);
      assert.equal(h.state.maxActive, 1);
      assert.strictEqual(summary!.model, normal!.model);
      assert.deepEqual(summary!.context.messages.slice(0, 3), normalContext.messages.slice(0, 3));
      assert.strictEqual(summary!.context.messages[2], normalContext.messages[2]);
      assert.equal(summary!.context.messages.at(-1)?.content, SUMMARY_INSTRUCTION);
      for (const key of [
        "sessionId",
        "apiKey",
        "headers",
        "env",
        "transport",
        "cacheRetention",
        "identity",
        "metadata",
        "timeoutMs",
        "maxRetryDelayMs",
        "maxRetries",
      ] as const)
        assert.deepEqual(summary!.options[key], normal!.options[key], key);
      assert.equal(summary!.options.onPayload, undefined);
      assert.equal(summary!.options.onResponse, undefined);
      assert.equal(summary!.options.onProviderStreamEvent, undefined);
      assert.equal(summary!.options.telemetry, undefined);
      assert.deepEqual(callbackKinds, ["payload:normal", "response:200", "stream:normal"]);
      assert.doesNotMatch(JSON.stringify(normal!.context), /OLD |old answer/);
      assert.match(JSON.stringify(normal!.context), /Saved goals|RECENT|PENDING/);
      assert.strictEqual(normal!.context.messages.at(-1), normalContext.messages.at(-1));
      assert.match(JSON.stringify(h.manager.getEntries()), /OLD |old answer/);
      assert.equal(states(h).length, 1);
      assert.equal(
        h.manager.getEntries().filter((entry) => entry.type === "context_edit").length,
        0,
      );
      commitDrafts(h.manager, pendingProjection(h.manager).drafts);
      assert.deepEqual(
        convertToLlm(h.manager.buildSessionProjection().messages),
        normal!.context.messages,
      );
      assert.deepEqual(h.notices, []);
    } finally {
      h.gates.close();
    }
  });

  it("passes a fitting request through without summarization", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 100);
      assert.equal((await send(h)).stopReason, "stop");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["normal"],
      );
      assert.deepEqual(states(h), []);
    } finally {
      h.gates.close();
    }
  });

  for (const reason of ["error", "aborted", "length", "toolUse"] as const) {
    it(`keeps raw and performs zero lower normal streams after summary ${reason}`, async () => {
      const h = await gateFixture();
      try {
        seedConversation(h.manager, 12_500);
        const raw = h.manager.getEntries();
        h.state.summaryReason = reason;
        const callbacks: unknown[] = [];
        const result = await send(h, {
          onPayload(payload) {
            callbacks.push(payload);
          },
          onResponse(response) {
            callbacks.push(response);
          },
          onProviderStreamEvent(data) {
            callbacks.push(data);
          },
        });
        assert.equal(result.stopReason, "aborted");
        assert.deepEqual(
          h.state.requests.map((request) => request.kind),
          ["summary"],
        );
        assert.deepEqual(
          h.manager
            .getEntries()
            .filter(
              (entry) => entry.type !== "custom" || entry.customType !== AUTO_COMPACTION_REQUEST,
            ),
          raw,
        );
        assert.deepEqual(callbacks, []);
        assert.equal(h.notices.length, 1);
      } finally {
        h.gates.close();
      }
    });
  }

  it("rejects an empty summary without any normal stream or replacement", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.state.summaryText = " \n";
      assert.equal((await send(h)).stopReason, "aborted");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary"],
      );
      assert.deepEqual(states(h), []);
    } finally {
      h.gates.close();
    }
  });

  it("checks the actual summary again and refuses an over-budget result", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.state.summaryText = "x".repeat(100_000);
      assert.equal((await send(h)).stopReason, "aborted");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary"],
      );
      assert.deepEqual(states(h), []);
    } finally {
      h.gates.close();
    }
  });

  it("does not call even the summary provider after an initial abort", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.controller.abort();
      const result = await h.registry
        .getProvider(h.provider.id)!
        .streamSimple(
          h.model,
          normalizeContext({ messages: convertToLlm(h.manager.buildSessionProjection().messages) }),
          { sessionId: h.manager.getSessionId(), signal: h.controller.signal },
        )
        .result();
      assert.equal(result.stopReason, "aborted");
      assert.deepEqual(h.state.requests, []);
    } finally {
      h.gates.close();
    }
  });

  for (const change of ["abort", "branch", "session", "new-input"] as const) {
    it(`discards an unapplied summary after ${change} during generation`, async () => {
      const h = await gateFixture();
      try {
        const ids = seedConversation(h.manager, 12_500);
        h.state.beforeReply = (capture) => {
          if (capture.kind !== "summary") return;
          if (change === "abort") h.controller.abort();
          if (change === "branch") h.manager.branch(ids.old);
          if (change === "session") h.manager.newSession();
          if (change === "new-input")
            h.manager.appendMessage({ role: "user", content: "NEW INPUT", timestamp: 100 });
        };
        const result = await send(h, { signal: h.controller.signal });
        assert.equal(result.stopReason, "aborted");
        assert.deepEqual(
          h.state.requests.map((request) => request.kind),
          ["summary"],
        );
        assert.deepEqual(states(h), []);
      } finally {
        h.gates.close();
      }
    });
  }

  it("terminates with zero sends when every finite candidate is infeasible", async () => {
    const h = await gateFixture();
    try {
      h.manager.appendMessage({
        role: "user",
        content: "new input" + "x".repeat(100_000),
        timestamp: 1,
      });
      const raw = h.manager.getEntries();
      assert.equal((await send(h)).stopReason, "aborted");
      assert.deepEqual(h.state.requests, []);
      assert.deepEqual(h.manager.getEntries(), raw);
      assert.match(h.notices[0]!, /both summary and normal/);
    } finally {
      h.gates.close();
    }
  });

  it("keeps a successful summary when the subsequent ordinary request fails", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.state.normalReason = "error";
      assert.equal((await send(h)).stopReason, "error");
      assert.equal(states(h).length, 1);
      assert.ok(pendingProjection(h.manager).drafts.length > 0);
      assert.match(JSON.stringify(h.manager.getEntries()), /OLD /);
    } finally {
      h.gates.close();
    }
  });

  it("uses the finite request timeout as a summary abort boundary", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.state.beforeReply = async (capture) => {
        if (capture.kind !== "summary") return;
        await new Promise<void>((resolve) =>
          capture.options.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
      };
      assert.equal((await send(h, { timeoutMs: 20 })).stopReason, "aborted");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary"],
      );
      assert.deepEqual(states(h), []);
    } finally {
      h.gates.close();
    }
  });
});

describe("effective cap preflight", () => {
  for (const [api, field] of [
    ["openai-responses", "max_output_tokens"],
    ["azure-openai-responses", "max_output_tokens"],
    ["openai-completions", "max_completion_tokens"],
  ] as const) {
    for (const simple of [true, false]) {
      it(`passes a first ${api} ${simple ? "simple" : "raw"} request once without summary when the model sampling cap fits`, async () => {
        const h = await gateFixture({
          api,
          contextWindow: 16_000,
          maxTokens: 10_000,
          samplingParams: { [field]: 1_000 },
        });
        try {
          const content = "x".repeat(14_000);
          h.manager.appendMessage({ role: "user", content, timestamp: 1 });
          assert.equal((await send(h, { maxTokens: 10_000 }, simple)).stopReason, "stop");
          assert.deepEqual(
            h.state.requests.map((request) => request.kind),
            ["normal"],
          );
          assert.equal(outputBudget(h.model, h.state.requests[0]!.options, simple), 1_000);
          assert.equal(h.state.requests[0]!.context.messages[0]!.content, content);
          assert.deepEqual(states(h), []);
          assert.deepEqual(h.notices, []);
        } finally {
          h.gates.close();
        }
      });
    }
  }

  for (const simple of [true, false]) {
    for (const source of ["thinking", "request"] as const) {
      it(`passes a fitting ${simple ? "simple" : "raw"} ${source} override with its original input`, async () => {
        const h = await gateFixture({
          contextWindow: 16_000,
          maxTokens: 10_000,
          reasoning: true,
          samplingParams: { max_output_tokens: 10_000 },
          samplingParamsByThinkingLevel: {
            low: { max_output_tokens: source === "thinking" ? 1_000 : 10_000 },
          },
        });
        try {
          h.manager.appendMessage({ role: "user", content: "x".repeat(14_000), timestamp: 1 });
          const level = simple
            ? { reasoning: "low" as const }
            : { reasoningEffort: "low" as const };
          const options = {
            ...level,
            ...(source === "request" ? { samplingParams: { max_output_tokens: 1_000 } } : {}),
          };
          assert.equal((await send(h, options, simple)).stopReason, "stop");
          assert.deepEqual(
            h.state.requests.map((request) => request.kind),
            ["normal"],
          );
          assert.equal(outputBudget(h.model, options, simple), 1_000);
          assert.deepEqual(states(h), []);
        } finally {
          h.gates.close();
        }
      });
    }

    it(`blocks all lower sends when a ${simple ? "simple" : "raw"} sampling override raises the effective ceiling`, async () => {
      const h = await gateFixture({
        contextWindow: 16_000,
        maxTokens: 1_000,
        samplingParams: { max_output_tokens: 1_000 },
      });
      try {
        h.manager.appendMessage({ role: "user", content: "x".repeat(14_000), timestamp: 1 });
        assert.equal(
          (await send(h, { maxTokens: 500, samplingParams: { max_output_tokens: 15_000 } }, simple))
            .stopReason,
          "aborted",
        );
        assert.deepEqual(h.state.requests, []);
        assert.deepEqual(states(h), []);
      } finally {
        h.gates.close();
      }
    });

    for (const oversizedSummary of [false, true]) {
      it(`uses effective caps before and after a ${simple ? "simple" : "raw"} summary (${oversizedSummary ? "rejects oversized output" : "continues"})`, async () => {
        const h = await gateFixture({
          contextWindow: 12_000,
          maxTokens: 10_000,
          samplingParams: { max_output_tokens: 1_000 },
        });
        try {
          seedConversation(h.manager, 12_500);
          if (oversizedSummary) h.state.summaryText = "x".repeat(40_000);
          const result = await send(h, {}, simple);
          assert.equal(result.stopReason, oversizedSummary ? "aborted" : "stop");
          assert.deepEqual(
            h.state.requests.map((request) => request.kind),
            oversizedSummary ? ["summary"] : ["summary", "normal"],
          );
          const summary = h.state.requests[0]!;
          assert.equal(
            summary.options.samplingParams?.max_output_tokens,
            summary.options.maxTokens,
          );
          assert.equal(requestFits(h.model, summary.context, summary.options, simple), true);
          assert.equal(outputBudget(h.model, summary.options, simple), summary.options.maxTokens);
          assert.equal(states(h).length, oversizedSummary ? 0 : 1);
          if (!oversizedSummary) {
            const normal = h.state.requests[1]!;
            assert.equal(outputBudget(h.model, normal.options, simple), 1_000);
            assert.equal(requestFits(h.model, normal.context, normal.options, simple), true);
          }
        } finally {
          h.gates.close();
        }
      });
    }
  }
});

describe("session serialization and provider wrapper restoration", () => {
  it("serializes an already-running warm request before summary and ordinary dispatch", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      h.state.beforeReply = async (capture) => {
        if (capture.kind === "normal" && capture.options.maxTokens === 1) {
          started.resolve();
          await release.promise;
        }
      };
      const warm = h.registry
        .streamSimple(
          h.model,
          { messages: [{ role: "system", content: "cache prefix", timestamp: 1 }] },
          { maxTokens: 1, sessionId: h.manager.getSessionId() },
        )
        .result();
      await started.promise;
      const normal = send(h);
      await Promise.resolve();
      assert.equal(h.state.requests.length, 1);
      release.resolve();
      await Promise.all([warm, normal]);
      assert.deepEqual(h.state.timeline, [
        "normal:start",
        "normal:end",
        "summary:start",
        "summary:end",
        "normal:start",
        "normal:end",
      ]);
      assert.equal(h.state.maxActive, 1);
      assert.equal(h.gates.isBusy(), false);
    } finally {
      h.gates.close();
    }
  });

  it("keeps the affinity leased after timeout until an uncooperative summary stream ends, including reload", async () => {
    const h = await gateFixture();
    const release = Promise.withResolvers<void>();
    let reloaded: ReturnType<typeof installProviderGates> | undefined;
    try {
      seedConversation(h.manager, 12_500);
      h.state.beforeReply = async (capture) => {
        if (capture.kind === "summary") await release.promise;
      };
      assert.equal((await send(h, { timeoutMs: 20 })).stopReason, "aborted");
      assert.equal(h.gates.isBusy(), true);
      h.gates.close();
      reloaded = installProviderGates(h.pi, () => h.ctx);
      await reloaded.ensure();
      assert.equal((await send(h)).stopReason, "aborted");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary"],
      );
      release.resolve();
      for (let index = 0; index < 20 && reloaded.isBusy(); index++) await Promise.resolve();
      assert.equal(reloaded.isBusy(), false);
      assert.equal((await send(h)).stopReason, "stop");
      assert.equal(h.state.maxActive, 1);
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "summary", "normal"],
      );
    } finally {
      release.resolve();
      reloaded?.close();
      h.gates.close();
    }
  });

  it("blocks a reentrant registry call instead of deadlocking or wrapping the summary again", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      let nestedReason: string | undefined;
      h.state.beforeReply = async (capture) => {
        if (capture.kind !== "normal") return;
        const nested = await send(h);
        nestedReason = nested.stopReason;
      };
      assert.equal((await send(h)).stopReason, "stop");
      assert.equal(nestedReason, "aborted");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.equal(h.state.maxActive, 1);
    } finally {
      h.gates.close();
    }
  });

  it("does not double-wrap during repeated ensure calls", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      await h.gates.ensure();
      await h.gates.ensure();
      assert.equal((await send(h)).stopReason, "stop");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
    } finally {
      h.gates.close();
    }
  });

  it("delegates catalog publication and uses current auth and updated model limits", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      h.state.pendingModels = [{ ...h.model, id: "physical-v2", contextWindow: 12_100 }];
      h.state.authRevision = "synthetic-v2";
      await h.runtime.setRuntimeApiKey(h.provider.id, "runtime-key-v2");
      await h.registry.refresh({ providers: [h.provider.id], allowNetwork: false });
      const model = h.registry.find(h.provider.id, "physical-v2")!;
      assert.ok(model);
      const result = await h.registry
        .streamSimple(
          model,
          { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
          { sessionId: h.manager.getSessionId() },
        )
        .result();
      assert.equal(result.stopReason, "stop");
      assert.equal(h.state.requests[0]!.model.id, "physical-v2");
      assert.equal(h.state.requests[0]!.model.contextWindow, 12_100);
      assert.equal(h.state.requests[0]!.options.apiKey, "runtime-key-v2");
      assert.equal(h.state.requests[0]!.options.headers?.["X-Auth-Revision"], "synthetic-v2");
    } finally {
      h.gates.close();
    }
  });

  it("wraps both APIs of a mixed native chat provider and raw stream dispatch", async () => {
    const h = await gateFixture();
    try {
      h.state.models.push({ ...h.model, id: "other-api", api: "openai-completions" as Api });
      await h.registry.refresh({ allowNetwork: false });
      seedConversation(h.manager, 12_500);
      const model = h.registry.find(h.provider.id, "other-api")!;
      const result = await h.registry
        .stream(
          model,
          { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
          { sessionId: h.manager.getSessionId() },
        )
        .result();
      assert.equal(result.stopReason, "stop");
      assert.deepEqual(
        h.state.requests.map((request) => request.model.api),
        ["openai-completions", "openai-completions"],
      );
    } finally {
      h.gates.close();
    }
  });

  it("restores its predecessor on close and installs a fresh gate on reload", async () => {
    const h = await gateFixture();
    h.gates.close();
    assert.strictEqual(h.registry.getRegisteredNativeProvider(h.provider.id), h.provider);
    const reloaded = installProviderGates(h.pi, () => h.ctx);
    await reloaded.ensure();
    try {
      seedConversation(h.manager, 12_500);
      assert.equal((await send(h)).stopReason, "stop");
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
    } finally {
      reloaded.close();
    }
  });

  it("does not restore an old provider over a newer registration", async () => {
    const h = await gateFixture();
    const foreign = fakeProvider(h.provider.id).provider;
    h.registry.registerProvider(foreign);
    h.gates.close();
    assert.strictEqual(h.registry.getRegisteredNativeProvider(h.provider.id), foreign);
  });
});

const returnedUsage = {
  input: 1_200,
  output: 90,
  cacheRead: 300,
  cacheWrite: 40,
  totalTokens: 1_630,
  cost: { input: 0.012, output: 0.009, cacheRead: 0.003, cacheWrite: 0.004, total: 0.028 },
};

function requestLogs(h: Awaited<ReturnType<typeof gateFixture>>): AutoCompactionRequest[] {
  return h.manager
    .getEntries()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === AUTO_COMPACTION_REQUEST
        ? [entry.data as AutoCompactionRequest]
        : [],
    );
}

describe("automatic compaction request history", () => {
  for (const [stopReason, outcome, reason] of [
    ["stop", "success", "applied"],
    ["error", "error", "stop_error"],
    ["aborted", "aborted", "stop_aborted"],
    ["length", "error", "stop_length"],
    ["toolUse", "error", "stop_toolUse"],
  ] as const) {
    it(`records the returned usage and safe result for ${stopReason}`, async () => {
      const h = await gateFixture();
      try {
        seedConversation(h.manager, 12_500);
        const originalLeaf = h.manager.getLeafId();
        const rawMessages = h.manager.getEntries().filter((entry) => entry.type === "message");
        h.state.summaryReason = stopReason;
        h.state.summaryUsage = returnedUsage;
        await send(h, { apiKey: "secret-request-key" });
        const logs = requestLogs(h);
        assert.equal(logs.length, 1);
        const log = logs[0]!;
        assert.deepEqual(
          {
            outcome: log.outcome,
            reason: log.reason,
            stopReason: log.stopReason,
            usage: log.usage,
          },
          { outcome, reason, stopReason, usage: returnedUsage },
        );
        assert.equal(log.version, 1);
        assert.match(log.requestId, /^[0-9a-f-]{36}$/);
        assert.ok(Date.parse(log.finishedAt) >= Date.parse(log.startedAt));
        assert.equal(log.provider, h.model.provider);
        assert.equal(log.model, h.model.id);
        assert.equal(log.api, h.model.api);
        assert.equal(log.sessionId, h.manager.getSessionId());
        assert.equal(log.leafId, originalLeaf);
        assert.doesNotMatch(
          JSON.stringify(log),
          /OLD |Saved goals|secret-request-key|Synthetic summary|payload|content/,
        );
        assert.deepEqual(
          h.manager.getEntries().filter((entry) => entry.type === "message"),
          rawMessages,
        );
        assert.equal(states(h).length, outcome === "success" ? 1 : 0);
      } finally {
        h.gates.close();
      }
    });
  }

  for (const [text, reason] of [
    [" \n", "empty_summary"],
    ["x".repeat(100_000), "summary_over_budget"],
  ]) {
    it(`keeps usage when the summary is not adopted: ${reason}`, async () => {
      const h = await gateFixture();
      try {
        seedConversation(h.manager, 12_500);
        h.state.summaryUsage = returnedUsage;
        h.state.summaryText = text!;
        assert.equal((await send(h)).stopReason, "aborted");
        const [log] = requestLogs(h);
        assert.equal(log!.outcome, "error");
        assert.equal(log!.reason, reason);
        assert.deepEqual(log!.usage, returnedUsage);
      } finally {
        h.gates.close();
      }
    });
  }

  for (const failure of ["throw", "reject"] as const) {
    it(`records ${failure} without inventing usage or saving the provider error text`, async () => {
      const h = await gateFixture();
      try {
        seedConversation(h.manager, 12_500);
        h.state.summaryFailure = failure;
        assert.equal((await send(h)).stopReason, "aborted");
        const logs = requestLogs(h);
        assert.equal(logs.length, 1);
        assert.equal(logs[0]!.outcome, "error");
        assert.equal(logs[0]!.reason, failure === "throw" ? "provider_throw" : "stream_rejected");
        assert.equal(logs[0]!.usage, undefined);
        assert.equal(logs[0]!.stopReason, undefined);
        assert.doesNotMatch(JSON.stringify(logs), /secret-key|request-payload/);
      } finally {
        h.gates.close();
      }
    });
  }

  for (const change of ["branch", "new-input"] as const) {
    it(`records returned usage on ${change} without applying the summary`, async () => {
      const h = await gateFixture();
      try {
        const ids = seedConversation(h.manager, 12_500);
        h.state.summaryUsage = returnedUsage;
        h.state.beforeReply = (capture) => {
          if (capture.kind !== "summary") return;
          if (change === "branch") h.manager.branch(ids.old);
          else h.manager.appendMessage({ role: "user", content: "NEW", timestamp: 100 });
        };
        await send(h);
        const [log] = requestLogs(h);
        assert.equal(log!.reason, "branch_changed");
        assert.equal(log!.leafId, ids.pending);
        assert.deepEqual(log!.usage, returnedUsage);
        assert.equal(states(h).length, 0);
      } finally {
        h.gates.close();
      }
    });
  }

  for (const cancellation of ["abort", "timeout", "shutdown"] as const) {
    it(`finalizes ${cancellation} once and ignores a late summary result`, async () => {
      const h = await gateFixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        seedConversation(h.manager, 12_500);
        h.state.summaryUsage = returnedUsage;
        h.state.beforeReply = async (capture) => {
          if (capture.kind !== "summary") return;
          started.resolve();
          await release.promise;
        };
        const pending = send(h, {
          signal: h.controller.signal,
          timeoutMs: cancellation === "timeout" ? 20 : 10_000,
        });
        await started.promise;
        if (cancellation === "abort") h.controller.abort();
        if (cancellation === "shutdown") h.gates.close();
        assert.equal((await pending).stopReason, "aborted");
        const logs = requestLogs(h);
        assert.equal(logs.length, 1);
        assert.equal(logs[0]!.outcome, "aborted");
        assert.equal(
          logs[0]!.reason,
          cancellation === "shutdown"
            ? "owner_closed"
            : cancellation === "timeout"
              ? "timeout"
              : "aborted",
        );
        assert.equal(logs[0]!.usage, undefined);
        const entryCount = h.manager.getEntries().length;
        release.resolve();
        for (let i = 0; i < 30 && h.gates.isBusy(); i++) await Promise.resolve();
        assert.equal(h.gates.isBusy(), false);
        assert.deepEqual(requestLogs(h), logs);
        assert.equal(h.manager.getEntries().length, entryCount);
      } finally {
        release.resolve();
        h.gates.close();
      }
    });
  }

  it("does not recreate history on normal retry or reload, but gives a new dispatch a new ID", async () => {
    const h = await gateFixture();
    let reloaded: ReturnType<typeof installProviderGates> | undefined;
    try {
      const ids = seedConversation(h.manager, 12_500);
      h.state.normalReason = "error";
      await send(h);
      const original = requestLogs(h);
      commitDrafts(h.manager, pendingProjection(h.manager).drafts);
      await send(h);
      h.gates.close();
      reloaded = installProviderGates(h.pi, () => h.ctx);
      await reloaded.ensure();
      await send(h);
      assert.deepEqual(requestLogs(h), original);
      h.manager.branch(ids.pending);
      assert.deepEqual(requestLogs(h), original);
      await send(h);
      const retried = requestLogs(h);
      assert.equal(retried.length, 2);
      assert.notEqual(retried[0]!.requestId, retried[1]!.requestId);
    } finally {
      reloaded?.close();
      h.gates.close();
    }
  });

  it("keeps a successful compression and normal dispatch when request logging fails", async () => {
    const h = await gateFixture();
    try {
      seedConversation(h.manager, 12_500);
      const append = h.pi.appendEntry.bind(h.pi);
      h.pi.appendEntry = (customType, data) => {
        if (customType === AUTO_COMPACTION_REQUEST) throw new Error("Synthetic write failure");
        return append(customType, data);
      };
      assert.equal((await send(h)).stopReason, "stop");
      assert.equal(states(h).length, 1);
      assert.match(h.notices[0]!, /could not save/);
      assert.deepEqual(
        h.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
    } finally {
      h.gates.close();
    }
  });
});
