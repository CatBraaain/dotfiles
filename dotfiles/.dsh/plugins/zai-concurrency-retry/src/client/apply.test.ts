import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { registerZaiRetryChatNode, type ZaiRetryWaitNode } from "./apply";

/** Opaque stand-in for the react component (kept react-free on purpose). */
const dummyComponent = (props: { readonly node: ZaiRetryWaitNode }) => props.node;

/** Handwritten stub capturing every `ctx.slots.inject` / `ctx.slots.register` call. */
function createStubSlots() {
  const injectKeys: string[] = [];
  const registerCalls: Array<{
    name: string;
    key: string;
    component: unknown;
  }> = [];
  let injectFactory: (() => void) | undefined;

  const ctx = {
    slots: {
      inject(key: string, factory: () => void): void {
        injectKeys.push(key);
        injectFactory = factory;
      },
      register(spec: { name: string; key: string }, component: unknown): void {
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

describe("registerZaiRetryChatNode", () => {
  it("injects against the chat-node seat", () => {
    const stub = createStubSlots();

    registerZaiRetryChatNode(stub.ctx, dummyComponent);

    assert.equal(stub.injectKeys.length, 1);
    assert.equal(stub.injectKeys[0], "conversation.chat.node");
  });

  it("registers the component under the plugin kind key once the inject factory runs", () => {
    const stub = createStubSlots();
    registerZaiRetryChatNode(stub.ctx, dummyComponent);

    stub.runInjectFactory();

    assert.equal(stub.registerCalls.length, 1);
    const call = stub.registerCalls[0];
    assert.equal(call.name, "conversation.chat.node");
    assert.equal(call.key, "zai-concurrency-retry/wait");
    assert.equal(call.component, dummyComponent);
  });
});
