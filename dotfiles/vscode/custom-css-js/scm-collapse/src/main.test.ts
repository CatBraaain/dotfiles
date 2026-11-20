import { beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  BUTTON_SELECTOR,
  EXPANDED_ROW_SELECTOR,
  MAX_ATTEMPTS,
  PANE_ID,
  POLL_INTERVAL_MS,
  start,
} from "./main.ts";

type Timer = { fn: () => void; at: number };

class FakeButton {
  disabled = false;
  dispatched: string[] = [];
  dispatchEvent(event: { type: string }): boolean {
    this.dispatched.push(event.type);
    return true;
  }
  closest(): { classList: { contains(name: string): boolean } } {
    return {
      classList: { contains: (name: string) => name === "disabled" && this.disabled },
    };
  }
}

class FakePane {
  isConnected = true;
  visible = true;
  expandedRows = 0;
  button = new FakeButton();

  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }

  querySelector(selector: string): unknown {
    if (selector === EXPANDED_ROW_SELECTOR) return this.expandedRows > 0 ? {} : null;
    if (selector === BUTTON_SELECTOR) return this.button;
    return null;
  }
}

class Harness {
  now = 0;
  timers: Timer[] = [];
  pane: FakePane | null = null;
  observeOptions: unknown = null;
  onMutate: (() => void) | null = null;

  window = {
    setTimeout: (fn: () => void, delay: number): number => {
      this.timers.push({ fn, at: this.now + delay });
      return this.timers.length;
    },
    __scmCollapseAutoFold: undefined as boolean | undefined,
    __scmCollapseObserver: undefined as unknown,
  };

  document = {
    getElementById: (id: string): unknown => (id === PANE_ID ? this.pane : null),
  };

  MutationObserver = class {
    constructor(callback: () => void) {
      harness.onMutate = callback;
    }
    observe(_target: unknown, options: unknown): void {
      harness.observeOptions = options;
    }
  };
}

let harness: Harness;

function advance(ms: number): void {
  const target = harness.now + ms;
  for (;;) {
    harness.timers.sort((a, b) => a.at - b.at);
    const next = harness.timers[0];
    if (!next || next.at > target) break;
    harness.now = next.at;
    harness.timers.shift();
    next.fn();
  }
  harness.now = target;
}

beforeEach(() => {
  harness = new Harness();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = harness.window;
  globals.document = harness.document;
  globals.MutationObserver = harness.MutationObserver;
  globals.MouseEvent = class FakeMouseEvent {
    constructor(public type: string) {}
  };
});

describe("scm-collapse", () => {
  it("targets the SCM view pane and its collapse-all button", () => {
    assert.equal(PANE_ID, "workbench.view.scm");
    assert.equal(EXPANDED_ROW_SELECTOR, ".monaco-list-row[aria-expanded='true']");
    assert.equal(BUTTON_SELECTOR, ".action-item .codicon-collapse-all");
  });

  it("finishes the collapse cycle within 15 seconds", () => {
    assert.ok(MAX_ATTEMPTS * POLL_INTERVAL_MS <= 15_000);
  });

  it("observes class and style changes so reopening the view is detected", () => {
    start();
    assert.deepEqual(harness.observeOptions, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  });

  it("collapses once when the pane is visible with an expanded row", () => {
    harness.pane = new FakePane();
    harness.pane.expandedRows = 1;
    start();
    assert.deepEqual(harness.pane.button.dispatched, ["mousedown", "mouseup", "click"]);
    assert.equal(harness.timers.length, 0);
  });

  it("does nothing while the pane is hidden", () => {
    harness.pane = new FakePane();
    harness.pane.visible = false;
    start();
    assert.equal(harness.pane.button.dispatched.length, 0);
    assert.equal(harness.timers.length, 0);
  });

  it("waits for the list to render before collapsing once", () => {
    harness.pane = new FakePane();
    start();
    assert.equal(harness.pane.button.dispatched.length, 0);
    assert.equal(harness.timers.length, 1);
    harness.pane.expandedRows = 1;
    advance(POLL_INTERVAL_MS);
    assert.deepEqual(harness.pane.button.dispatched, ["mousedown", "mouseup", "click"]);
    assert.equal(harness.timers.length, 0);
  });

  it("collapses again when the view is closed and reopened", () => {
    harness.pane = new FakePane();
    harness.pane.expandedRows = 1;
    start();
    const firstClicks = harness.pane.button.dispatched.length;
    assert.ok(firstClicks > 0);

    harness.pane.visible = false;
    harness.onMutate?.();
    advance(POLL_INTERVAL_MS);
    harness.pane.visible = true;
    harness.onMutate?.();
    advance(POLL_INTERVAL_MS);
    assert.equal(harness.pane.button.dispatched.length, firstClicks * 2);
  });

  it("gives up without clicking when no expanded row appears", () => {
    harness.pane = new FakePane();
    start();
    advance(MAX_ATTEMPTS * POLL_INTERVAL_MS + POLL_INTERVAL_MS);
    assert.equal(harness.pane.button.dispatched.length, 0);
    assert.equal(harness.timers.length, 0);
  });
});
