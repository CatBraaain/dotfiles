import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { urgencyOf, type UsageState } from "./urgency";

const NOW = Date.parse("2026-06-17T12:00:00+09:00");
const MINUTE_MS = 60_000;

function state(
  remaining: number | null,
  remainingMinutes: number,
  windowMinutes: number | null,
): UsageState {
  return {
    remaining,
    resetsAt: new Date(NOW + remainingMinutes * MINUTE_MS).toISOString(),
    windowMinutes,
  };
}

describe("urgencyOf", () => {
  it.each([300, 10_080, 43_200])(
    "normalizes equal window fractions for %s minutes",
    (windowMinutes) => {
      assert.equal(urgencyOf(state(50, windowMinutes / 2, windowMinutes), NOW), 1);
      assert.equal(urgencyOf(state(90, windowMinutes / 2, windowMinutes), NOW), 1.8);
    },
  );

  it("clamps remaining time to one hour", () => {
    assert.equal(urgencyOf(state(80, 6, 300), NOW), 4);
  });

  it("preserves exhausted quota as zero", () => {
    assert.equal(urgencyOf(state(0, 100, 300), NOW), 0);
  });

  it.each([0, -1])("returns null after reset: %s", (minutes) => {
    assert.equal(urgencyOf(state(80, minutes, 300), NOW), null);
  });

  it.each([null, 0, -1, NaN, Infinity])("returns null for unavailable duration: %s", (minutes) => {
    assert.equal(urgencyOf(state(80, 100, minutes), NOW), null);
  });

  it.each([null, -1, 101, NaN, Infinity])("returns null for invalid remaining: %s", (remaining) => {
    assert.equal(urgencyOf(state(remaining, 100, 300), NOW), null);
  });

  it("returns null for missing usage or invalid reset", () => {
    assert.equal(urgencyOf(undefined, NOW), null);
    assert.equal(urgencyOf({ ...state(80, 100, 300), resetsAt: "bad" }, NOW), null);
  });
});

describe("invalid urgency clocks", () => {
  it.each([NaN, Infinity, -Infinity])("returns null for now %s", (now) => {
    assert.equal(urgencyOf(state(80, 100, 300), now), null);
  });
  it("returns null for an unknown reset", () => {
    assert.equal(urgencyOf({ remaining: 0, windowMinutes: 300, resetsAt: null }, NOW), null);
  });
});
