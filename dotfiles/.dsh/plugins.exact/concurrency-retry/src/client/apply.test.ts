import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { registerConcurrencyRetryChatNode, type ConcurrencyRetryWaitNode } from "./apply";

const dummyComponent = (props: { readonly node: ConcurrencyRetryWaitNode }) => props.node;

function createStubSlots() {
  const injectKeys: string[] = [];
  const registerCalls: Array<{ name: string; key: string; component: unknown }> = [];
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

  return { ctx, injectKeys, registerCalls, runInjectFactory: () => injectFactory?.() };
}

describe("registerConcurrencyRetryChatNode", () => {
  it("injects against the chat-node seat", () => {
    const stub = createStubSlots();
    registerConcurrencyRetryChatNode(stub.ctx, dummyComponent);
    assert.equal(stub.injectKeys.length, 1);
    assert.equal(stub.injectKeys[0], "conversation.chat.node");
  });

  it("registers the component under the concurrency kind", () => {
    const stub = createStubSlots();
    registerConcurrencyRetryChatNode(stub.ctx, dummyComponent);
    stub.runInjectFactory();
    assert.equal(stub.registerCalls.length, 1);
    const call = stub.registerCalls[0];
    assert.equal(call.name, "conversation.chat.node");
    assert.equal(call.key, "concurrency-retry/wait");
    assert.equal(call.component, dummyComponent);
  });
});
