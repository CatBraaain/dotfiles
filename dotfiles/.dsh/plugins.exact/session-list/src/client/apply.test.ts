import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { LIST_CSS, directoryFlowOccupied, registerSessionList } from "./apply";

interface RegisteredEntry {
  name: string;
  priority: number | undefined;
  children: Record<string, unknown> | undefined;
  inject: (() => { hooks: Record<string, unknown> }) | undefined;
  component: unknown;
}

/** Handwritten stub capturing every `ctx.slots` call (kept react-free). */
function createStubContext(occupants: number) {
  const injectCalls: string[] = [];
  const registerCalls: RegisteredEntry[] = [];
  const entriesCalls: string[] = [];
  const subscribeCalls: string[] = [];
  const context = {
    workspaces: { list: { marker: "workspace-source" } },
    slots: {
      inject: (slot: string, callback: () => void) => {
        injectCalls.push(slot);
        callback();
      },
      register: (spec: { name: string; priority?: number; children?: Record<string, unknown>; inject?: () => unknown }, component: unknown) => {
        registerCalls.push({
          name: spec.name,
          priority: spec.priority,
          children: spec.children,
          inject: spec.inject as RegisteredEntry["inject"],
          component,
        });
      },
      entries: (key: string) => {
        entriesCalls.push(key);
        return Array.from({ length: occupants }, () => ({}));
      },
      subscribe: (key: string) => {
        subscribeCalls.push(key);
        return () => {};
      },
    },
  };
  return {
    ctx: context as unknown as Context,
    workspaceList: context.workspaces.list,
    injectCalls,
    registerCalls,
    entriesCalls,
    subscribeCalls,
  };
}

/** The injected hooks face of the single registration. */
function injectedHooks(stub: ReturnType<typeof createStubContext>): Record<string, unknown> {
  const inject = stub.registerCalls[0]?.inject;
  if (inject === undefined) throw new Error("registration must carry an inject factory");
  return inject().hooks;
}

describe("registerSessionList", () => {
  it("registers one lower-priority occupant into the sidebar workspace slot", () => {
    const stub = createStubContext(1);
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

  it("leaves the directory-flow child declaration to the stock entry", () => {
    const stub = createStubContext(1);
    registerSessionList(stub.ctx, dummyComponent);
    const entry = stub.registerCalls[0];
    // Re-declaring the stock-owned child hole is a registry error.
    assert.equal(entry?.children, undefined);
  });

  it("injects the workspace source and the flow-occupancy hook", () => {
    const stub = createStubContext(1);
    registerSessionList(stub.ctx, dummyComponent);
    const hooks = injectedHooks(stub);
    assert.equal(hooks.workspaces, stub.workspaceList);
    const flow = hooks.directoryFlow as { getSnapshot: () => boolean };
    assert.equal(flow.getSnapshot(), true);
    assert.deepEqual(stub.entriesCalls, ["sidebar.workspaces.directoryFlow"]);
  });

  it("reports an unoccupied hole as unavailable", () => {
    const stub = createStubContext(0);
    registerSessionList(stub.ctx, dummyComponent);
    const flow = injectedHooks(stub).directoryFlow as { getSnapshot: () => boolean };
    assert.equal(flow.getSnapshot(), false);
  });

  it("subscribes the occupancy to the directory-flow ledger", () => {
    const stub = createStubContext(1);
    registerSessionList(stub.ctx, dummyComponent);
    const flow = injectedHooks(stub).directoryFlow as { subscribe: (l: () => void) => () => void };
    const unsubscribe = flow.subscribe(() => {});
    assert.deepEqual(stub.subscribeCalls, ["sidebar.workspaces.directoryFlow"]);
    assert.equal(typeof unsubscribe, "function");
  });
});

describe("directoryFlowOccupied", () => {
  it("counts the hole entries to decide occupancy", () => {
    assert.equal(directoryFlowOccupied(0), false);
    assert.equal(directoryFlowOccupied(1), true);
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

  it("swaps the folder icon for the chevron only while the group row is hovered", () => {
    assert.match(LIST_CSS, /\.session-list-group-row:hover \.session-list-chevron\{display:inline-flex\}/);
    assert.match(LIST_CSS, /\.session-list-group-row:hover \.session-list-folder\{display:none\}/);
  });

  it("shows the workspace New Session action only while its group is hovered", () => {
    assert.match(LIST_CSS, /\.session-list-group-actions\{[^}]*display:none\}/);
    assert.match(LIST_CSS, /\.session-list-group-row:hover \.session-list-group-actions\{display:inline-flex\}/);
    assert.match(LIST_CSS, /\.session-list-group-action\{[^}]*cursor:pointer/);
  });
});

const dummyComponent = (): null => null;
