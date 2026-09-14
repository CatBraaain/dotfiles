import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { AGENTS_TRIGGER_CSS, registerAgentClassDisplay, TRIGGER_CLASS } from "./apply";

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
  it("injects against the input dock slot above the composer", () => {
    const stub = createStubSlots();

    registerAgentClassDisplay(stub.ctx, dummyComponent);

    assert.equal(stub.injectKeys.length, 1);
    assert.equal(stub.injectKeys[0], "conversation.input.dock");
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
    assert.equal(call.name, "conversation.input.dock");
    assert.equal(call.id, "agent-class");
    assert.equal(call.order, 2);
    assert.equal(call.component, dummyComponent);
  });
});

describe("AGENTS_TRIGGER_CSS", () => {
  it("hangs the stock interactive hover fill on the trigger class", () => {
    assert.match(
      AGENTS_TRIGGER_CSS,
      new RegExp(`\\.${TRIGGER_CLASS}:hover:not\\(:disabled\\)`),
    );
    assert.match(
      AGENTS_TRIGGER_CSS,
      /var\(--dsw-alias-interactive-bg-hover\)/,
    );
  });

  it("keeps the background reset out of inline style so the hover rule wins", () => {
    // The reset is a plain class rule; the hover rule must out-rank it, which
    // an inline `background: none` would defeat.
    assert.match(AGENTS_TRIGGER_CSS, new RegExp(`\\.${TRIGGER_CLASS} \\{\\n  background: none;`));
  });

  it("only styles the plugin-owned class", () => {
    // Two selectors, both scoped to the class: no bare element or universal rules.
    const selectors = AGENTS_TRIGGER_CSS
      .split("}")
      .map((rule) => rule.split("{")[0]?.trim())
      .filter((selector) => selector !== undefined && selector.length > 0);
    assert.deepEqual(selectors, [
      `.${TRIGGER_CLASS}`,
      `.${TRIGGER_CLASS}:hover:not(:disabled)`,
    ]);
  });
});
