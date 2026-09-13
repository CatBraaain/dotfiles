import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  SESSION_NAME_MAX_CHARS,
  type ChildRunOutcome,
  sessionNameFor,
  settleChildRun,
} from "./child-run.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("sessionNameFor", () => {
  it("joins the agent name and the first task line", () => {
    assert.equal(sessionNameFor("junior", "collect facts\nthen report"), "junior: collect facts");
  });

  it("trims the first line", () => {
    assert.equal(sessionNameFor("junior", "  padded task  \nmore"), "junior: padded task");
  });

  it("truncates by code points and appends an ellipsis", () => {
    const long = "あ".repeat(SESSION_NAME_MAX_CHARS + 5);
    const label = sessionNameFor("junior", long);
    assert.equal(label, `junior: ${"あ".repeat(SESSION_NAME_MAX_CHARS)}…`);
    assert.equal(Array.from(label).length, "junior: ".length + SESSION_NAME_MAX_CHARS + 1);
  });

  it("keeps a 30-code-point first line without an ellipsis", () => {
    const exact = "x".repeat(SESSION_NAME_MAX_CHARS);
    assert.equal(sessionNameFor("junior", exact), `junior: ${exact}`);
  });

  it("does not split surrogate pairs", () => {
    // UTF-16 slicing at index 30 would cut the 16th emoji in half.
    const emoji = "🦄".repeat(SESSION_NAME_MAX_CHARS + 1);
    const label = sessionNameFor("junior", emoji);
    assert.equal(label, `junior: ${"🦄".repeat(SESSION_NAME_MAX_CHARS)}…`);
  });

  it("falls back to the bare agent name when the first line is empty", () => {
    assert.equal(sessionNameFor("junior", ""), "junior");
    assert.equal(sessionNameFor("junior", "   \nnext"), "junior");
  });
});

describe("settleChildRun", () => {
  it("returns the final text of a completed run", () => {
    const settled = settleChildRun({ stopReason: "completed", output: text("done") }, "junior");
    assert.deepEqual(settled, { ok: true, text: "done" });
  });

  it("reports a completed run with empty output as an error", () => {
    const settled = settleChildRun({ stopReason: "completed", output: [] }, "junior");
    assert.equal(settled.ok, false);
    assert.equal(!settled.ok && settled.message, "child junior completed: (no output)");
  });

  it("reports a completed run without text blocks as an error", () => {
    const imageOnly = { type: "image" } as ChildRunOutcome["output"][number];
    const settled = settleChildRun({ stopReason: "completed", output: [imageOnly] }, "junior");
    assert.equal(!settled.ok && settled.message, "child junior completed: (no output)");
  });

  it("reports non-completed stop reasons as errors with the diagnostic", () => {
    const settled = settleChildRun(
      { stopReason: "error", diagnostic: "transport blew up", output: [] },
      "junior",
    );
    assert.equal(!settled.ok && settled.message, "child junior error: transport blew up");
  });

  it("falls back to the partial output text when there is no diagnostic", () => {
    const settled = settleChildRun({ stopReason: "aborted", output: text("partial") }, "junior");
    assert.equal(!settled.ok && settled.message, "child junior aborted: partial");
  });

  it("uses (no output) when a failure has neither diagnostic nor text", () => {
    const settled = settleChildRun({ stopReason: "aborted", output: [] }, "junior");
    assert.equal(!settled.ok && settled.message, "child junior aborted: (no output)");
  });
});
