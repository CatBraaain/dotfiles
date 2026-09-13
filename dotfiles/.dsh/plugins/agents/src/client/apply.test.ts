import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { registerAgentClassDisplay } from "./apply";

/** Opaque stand-in for the react component (kept react-free on purpose). */
const dummyComponent = () => null;

/** Handwritten stub capturing every `ctx.slots.inject` / `ctx.slots.register` call. */
function createStubSlots() {
  const injectKeys: string[] = [];
  const registerCalls: Array<{
    name: string;
    id: string;
    order: number;
    component: unknown;
  }> = [];
  let injectFactory: (() => void) | undefined;

  const ctx = {
    slots: {
      inject(key: string, factory: () => void): void {
        injectKeys.push(key);
        injectFactory = factory;
      },
      register(spec: { name: string; id: string; order: number }, component: unknown): void {
        registerCalls.push({ ...spec, component });
      },
    },
  } as unknown as Context;

  return {
    ctx,
    injectKeys,
    registerCalls,
    runInjectFactory: () => injectFactory?.(),
  };
}

describe("registerAgentClassDisplay", () => {
  it("injects against the composer dock slot", () => {
    const stub = createStubSlots();

    registerAgentClassDisplay(stub.ctx, dummyComponent);

    assert.equal(stub.injectKeys.length, 1);
    assert.equal(stub.injectKeys[0], "conversation.composer.dock");
  });

  it("does not register before the inject factory runs", () => {
    const stub = createStubSlots();

    registerAgentClassDisplay(stub.ctx, dummyComponent);

    assert.equal(stub.registerCalls.length, 0);
  });

  it("registers the component with the agent-class entry once the inject factory runs", () => {
    const stub = createStubSlots();
    registerAgentClassDisplay(stub.ctx, dummyComponent);

    stub.runInjectFactory();

    assert.equal(stub.registerCalls.length, 1);
    const call = stub.registerCalls[0];
    assert.equal(call.name, "conversation.composer.dock");
    assert.equal(call.id, "agent-class");
    assert.equal(call.order, 2);
    assert.equal(call.component, dummyComponent);
  });
});
