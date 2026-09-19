import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/shellQuote";

describe("shellQuote", () => {
  it("wraps a plain path in double quotes", () => {
    expect(shellQuote("/home/user/.pi/agent/sessions/x/y.jsonl")).toBe(
      '"/home/user/.pi/agent/sessions/x/y.jsonl"',
    );
  });

  it("handles paths with spaces", () => {
    expect(shellQuote("/home/my projects/x.jsonl")).toBe('"/home/my projects/x.jsonl"');
  });

  it("escapes double quotes", () => {
    expect(shellQuote('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  it("escapes dollar signs and backticks (no expansion inside double quotes)", () => {
    expect(shellQuote("$HOME")).toBe('"\\$HOME"');
    expect(shellQuote("a`b")).toBe('"a\\`b"');
  });

  it("escapes backslashes", () => {
    expect(shellQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("passes unicode through unchanged", () => {
    expect(shellQuote("/home/日本語/セッション.jsonl")).toBe('"/home/日本語/セッション.jsonl"');
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe('""');
  });
});
