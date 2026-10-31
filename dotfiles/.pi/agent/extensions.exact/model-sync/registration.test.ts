import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { convertToLlm, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { registerModels } from "./index.ts";
import { SYNC_PROVIDERS, type ModelDefinition } from "./core.ts";
import { fakeProvider, gateFixture, seedConversation } from "../recontext/test-fixture.ts";
import { registerProviderUpdate } from "../recontext/provider-update.ts";

async function fixture() {
  const h = await gateFixture();
  const fake = fakeProvider("openai");
  const legacy: ProviderConfig = {
    api: "openai-responses",
    apiKey: "synthetic-key",
    baseUrl: "https://fake.invalid/v1",
    models: fake.state.models,
    streamSimple: fake.provider.streamSimple,
  };
  h.registry.registerProvider("openai", legacy);
  h.gates.ensure();
  return {
    ...h,
    synced: fake,
    legacy,
    providerConfig: SYNC_PROVIDERS.find((provider) => provider.id === "openai")!,
  };
}

describe("model-sync atomic registration cooperation", () => {
  it("updates models and reinstalls the final native gate in one synchronous operation", async () => {
    const h = await fixture();
    try {
      seedConversation(h.manager, 12_500);
      const oldGate = h.registry.getRegisteredNativeProvider("openai");
      const models = [{ ...h.synced.state.models[0]!, id: "synced-model" }];
      registerModels(h.pi, h.ctx, h.providerConfig, models as ModelDefinition[]);
      const gate = h.registry.getRegisteredNativeProvider("openai");
      assert.ok(gate);
      assert.notStrictEqual(gate, oldGate);
      assert.ok(h.registry.find("openai", "synced-model"));
      const model = h.registry.find("openai", "synced-model")!;
      const result = await h.registry
        .streamSimple(
          model,
          { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
          { sessionId: h.manager.getSessionId() },
        )
        .result();
      assert.equal(result.stopReason, "stop");
      assert.deepEqual(
        h.synced.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
      assert.equal(h.synced.state.requests[0]!.model.id, "synced-model");
    } finally {
      h.gates.close();
    }
  });

  it("keeps the latest endpoint, header, auth, and catalog updates after cleanup", async () => {
    const h = await fixture();
    try {
      const models = [
        { ...h.synced.state.models[0]!, id: "latest", baseUrl: "https://updated.invalid/v2" },
      ];
      registerProviderUpdate(h.pi, h.ctx, "openai", {
        ...h.legacy,
        apiKey: "updated-auth",
        baseUrl: "https://updated.invalid/v2",
        headers: { "X-Updated": "yes" },
        models,
      });
      seedConversation(h.manager, 12_500);
      const model = h.registry.find("openai", "latest")!;
      await h.registry
        .streamSimple(
          model,
          { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
          { sessionId: h.manager.getSessionId() },
        )
        .result();
      const summary = h.synced.state.requests[0]!;
      assert.equal(summary.options.apiKey, "updated-auth");
      assert.equal(summary.options.headers?.["X-Updated"], "yes");
      assert.equal(summary.model.baseUrl, "https://updated.invalid/v2");
      h.gates.close();
      const restored = h.registry.getRegisteredProviderConfig("openai");
      assert.equal(restored?.apiKey, "updated-auth");
      assert.equal(restored?.baseUrl, "https://updated.invalid/v2");
      assert.equal(restored?.models?.[0]?.id, "latest");
      assert.strictEqual(restored?.streamSimple, h.legacy.streamSimple);
    } finally {
      h.gates.close();
    }
  });

  it("reinstalls the gate after a rejected update and reports the original registration error", async () => {
    const h = await fixture();
    try {
      assert.throws(
        () =>
          registerProviderUpdate(h.pi, h.ctx, "openai", {
            streamSimple: h.synced.provider.streamSimple,
          }),
        /api/i,
      );
      assert.ok(h.registry.getRegisteredNativeProvider("openai"));
      seedConversation(h.manager, 12_500);
      const model = h.registry.find("openai", "physical")!;
      assert.equal(
        (
          await h.registry
            .streamSimple(
              model,
              { messages: convertToLlm(h.manager.buildSessionProjection().messages) },
              { sessionId: h.manager.getSessionId() },
            )
            .result()
        ).stopReason,
        "stop",
      );
      assert.deepEqual(
        h.synced.state.requests.map((request) => request.kind),
        ["summary", "normal"],
      );
    } finally {
      h.gates.close();
    }
  });

  it("keeps a native gate after models-only registration for a builtin provider ID", async () => {
    const h = await gateFixture();
    try {
      const native = fakeProvider("openai");
      h.registry.registerProvider(native.provider);
      h.gates.ensure();
      registerModels(
        h.pi,
        h.ctx,
        SYNC_PROVIDERS.find((provider) => provider.id === "openai")!,
        native.state.models.map((model) => ({ ...model })),
      );
      assert.ok(h.registry.getRegisteredNativeProvider("openai"));
      assert.ok(h.registry.find("openai", "physical"));
      assert.equal(native.state.requests.length, 0);
    } finally {
      h.gates.close();
    }
  });
});
