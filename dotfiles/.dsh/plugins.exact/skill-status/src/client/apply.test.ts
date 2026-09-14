import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { registerSkillStatusDock } from "./apply";

/** Opaque stand-in for the react component (kept react-free on purpose). */
const dummyComponent = (props: { readonly useProjection: unknown }) => props.useProjection;

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

describe("registerSkillStatusDock", () => {
  it("injects against the input dock slot", () => {
    const stub = createStubSlots();

    registerSkillStatusDock(stub.ctx, dummyComponent);

    assert.equal(stub.injectKeys.length, 1);
    assert.equal(stub.injectKeys[0], "conversation.input.dock");
  });

  it("registers the component once the inject factory runs", () => {
    const stub = createStubSlots();
    registerSkillStatusDock(stub.ctx, dummyComponent);

    stub.runInjectFactory();

    assert.equal(stub.registerCalls.length, 1);
    const call = stub.registerCalls[0];
    assert.equal(call.name, "conversation.input.dock");
    assert.equal(call.id, "skill-status");
    assert.equal(call.order, 10);
    assert.equal(call.component, dummyComponent);
  });
});
