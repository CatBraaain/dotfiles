import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stampSuffix, stampTime } from "./stamp-time.ts";

const noon = new Date(2025, 0, 1, 12, 34, 56);
const noonIso = noon.toISOString();
const noonMs = noon.getTime();

describe("stampTime", () => {
  it("formats local 24-hour time with seconds", () => {
    assert.equal(stampTime(noonMs), "12:34:56");
    assert.equal(stampTime(noonIso), "12:34:56");
  });

  it("zero-pads small values", () => {
    const early = new Date(2025, 0, 1, 3, 4, 5);
    assert.equal(stampTime(early.getTime()), "03:04:05");
  });

  it("returns empty for missing or invalid values", () => {
    assert.equal(stampTime(undefined), "");
    assert.equal(stampTime(Number.NaN), "");
    assert.equal(stampTime("not-a-date"), "");
    assert.equal(stampTime(null as unknown as number), "");
  });
});

describe("stampSuffix", () => {
  it("right-aligns the stamp and fills the row to the exact width", () => {
    const line = "read ./notes.txt — 3 lines";
    const row = stampSuffix(line, "21:30:03", 60);
    assert.equal(visibleWidth(row), 60);
    assert.ok(row.endsWith("21:30:03"));
    assert.ok(row.startsWith(line));
  });

  it("keeps one space between truncated content and the stamp", () => {
    const line = "x".repeat(120);
    const row = stampSuffix(line, "21:30:03", 40);
    assert.equal(visibleWidth(row), 40);
    assert.ok(row.endsWith("21:30:03"));
    assert.match(stripAnsi(row), /^x+\.\.\. 21:30:03$/);
  });

  it("respects ANSI styling when measuring width", () => {
    const styled = `\x1b[36mread\x1b[39m ./notes.txt`;
    const row = stampSuffix(styled, "21:30:03", 60);
    assert.equal(visibleWidth(row), 60);
    assert.ok(stripAnsi(row).endsWith("21:30:03"));
    assert.ok(stripAnsi(row).startsWith("read ./notes.txt"));
  });

  it("keeps the row width when wide characters are truncated", () => {
    const line = "日本語".repeat(30);
    const row = stampSuffix(line, "21:30:03", 40);
    assert.equal(visibleWidth(row), 40);
    assert.ok(row.endsWith("21:30:03"));
  });

  it("returns the plain truncated line without a stamp", () => {
    assert.equal(stampSuffix("hello", "", 20), "hello");
    assert.equal(visibleWidth(stampSuffix("x".repeat(30), "", 20)), 20);
  });

  it("drops the stamp when the width cannot fit it", () => {
    const row = stampSuffix("hello", "21:30:03", 8);
    assert.equal(row, "hello");
    assert.ok(!row.includes("21:30:03"));
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
