import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_UPDATE_EVENT,
  registerProviderUpdate,
  type ProviderUpdate,
} from "./provider-update.ts";

function fixture() {
  const calls: string[] = [];
  const pi = {
    events: createEventBus(),
    registerProvider(providerId: string) {
      calls.push(providerId);
    },
  } as unknown as ExtensionAPI;
  const ctx = { modelRegistry: {} } as ExtensionContext;
  return { calls, pi, ctx };
}

describe("provider update handoff", () => {
  it("uses ordinary registration when replace-context has no listener", () => {
    const h = fixture();
    registerProviderUpdate(h.pi, h.ctx, "fake", { models: [] });
    assert.deepEqual(h.calls, ["fake"]);
  });

  it("lets the active owner finish registration synchronously without a duplicate", () => {
    const h = fixture();
    h.pi.events.on(PROVIDER_UPDATE_EVENT, (value) => {
      const update = value as ProviderUpdate;
      assert.strictEqual(update.registry, h.ctx.modelRegistry);
      update.handled = true;
      h.calls.push("before");
      update.register();
      h.calls.push("after");
    });
    registerProviderUpdate(h.pi, h.ctx, "fake", { models: [] });
    assert.deepEqual(h.calls, ["before", "fake", "after"]);
  });

  it("propagates a coordinated registration failure without retrying unwrapped", () => {
    const h = fixture();
    h.pi.events.on(PROVIDER_UPDATE_EVENT, (value) => {
      const update = value as ProviderUpdate;
      update.handled = true;
      update.error = new Error("registration failed");
    });
    assert.throws(
      () => registerProviderUpdate(h.pi, h.ctx, "fake", { models: [] }),
      /registration failed/,
    );
    assert.deepEqual(h.calls, []);
  });
});
