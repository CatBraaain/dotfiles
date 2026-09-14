import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { LIST_CSS, registerSessionList } from "./apply";

/** Handwritten stub capturing every `ctx.slots` call (kept react-free). */
function createStubContext() {
  const injectCalls: string[] = [];
  const registerCalls: Array<{ name: string; priority: number | undefined; component: unknown }> = [];
  const context = {
    workspaces: { list: { marker: "workspace-source" } },
    slots: {
      inject: (slot: string, callback: () => void) => {
        injectCalls.push(slot);
        callback();
      },
      register: (spec: { name: string; priority?: number }, component: unknown) => {
        registerCalls.push({ name: spec.name, priority: spec.priority, component });
      },
    },
  };
  return { ctx: context as unknown as Context, injectCalls, registerCalls };
}

describe("registerSessionList", () => {
  it("registers one lower-priority occupant into the sidebar workspace slot", () => {
    const stub = createStubContext();
    registerSessionList(stub.ctx, dummyComponent);
    assert.deepEqual(stub.injectCalls, ["sidebar.workspaces"]);
    assert.equal(stub.registerCalls.length, 1);
    const entry = stub.registerCalls[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.name, "sidebar.workspaces");
    // The single slot renders its lowest-priority registrant; the stock
    // browser registers without a priority (0), so ours must rank below.
    assert.ok((entry.priority ?? 0) < 0);
    assert.equal(entry.component, dummyComponent);
  });
});

describe("LIST_CSS", () => {
  it("styles the list rows exactly once through the shared root class", () => {
    assert.match(LIST_CSS, /\.session-list-row\{/);
    assert.equal(LIST_CSS.match(/\.session-list-root\{/g)?.length, 1);
  });

  it("hides the row actions until the row is hovered", () => {
    assert.match(LIST_CSS, /\.session-list-actions\{[^}]*display:none\}/);
    assert.match(LIST_CSS, /\.session-list-row:hover \.session-list-actions\{[^}]*display:inline-flex\}/);
  });
});

const dummyComponent = (): null => null;
