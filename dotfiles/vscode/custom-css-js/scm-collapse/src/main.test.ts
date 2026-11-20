import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  BUTTON_SELECTOR,
  EXPANDED_ROW_SELECTOR,
  MAX_ATTEMPTS,
  PANE_ID,
  POLL_INTERVAL_MS,
} from "./main.ts";

describe("scm-collapse", () => {
  it("targets the SCM view pane and its collapse-all button", () => {
    assert.equal(PANE_ID, "workbench.view.scm");
    assert.equal(EXPANDED_ROW_SELECTOR, ".monaco-list-row[aria-expanded='true']");
    assert.equal(BUTTON_SELECTOR, ".action-item .codicon-collapse-all");
  });

  it("stops retrying within 30 seconds", () => {
    assert.ok(MAX_ATTEMPTS * POLL_INTERVAL_MS <= 30_000);
  });
});
