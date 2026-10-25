import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  COMMAND_PREVIEW_LIMIT,
  ERROR_OUTPUT_PREVIEW_LIMIT,
  resultText,
  truncateErrorOutput,
  truncateText,
} from "./tool-text.ts";

describe("tool text utilities", () => {
  it("keeps text at the preview limit unchanged", () => {
    const text = "x".repeat(COMMAND_PREVIEW_LIMIT);
    assert.equal(truncateText(text), text);
  });

  it("uses the requested preview limit including the ellipsis", () => {
    assert.equal(truncateText("123456789", 8), "12345...");
  });

  it("keeps short error output unchanged", () => {
    assert.equal(truncateErrorOutput("failure"), "failure");
  });

  it("keeps the error tail and truncation marker within the limit", () => {
    const text = `head${"x".repeat(ERROR_OUTPUT_PREVIEW_LIMIT)}tail`;
    const truncated = truncateErrorOutput(text);
    assert.equal(truncated.length, ERROR_OUTPUT_PREVIEW_LIMIT);
    assert.ok(truncated.endsWith("tail\n\n[Output truncated; showing the tail.]"));
    assert.ok(!truncated.startsWith("head"));
  });

  it("returns only the first content block when it is text", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    assert.equal(resultText(result), "first");
  });

  it("returns empty text for a missing or non-text first block", () => {
    assert.equal(resultText({}), "");
    assert.equal(resultText({ content: [{ type: "image" }, { type: "text", text: "later" }] }), "");
  });
});
