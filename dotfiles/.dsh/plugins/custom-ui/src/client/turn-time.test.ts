import { strict as assert } from "node:assert/strict";
import { describe, it } from "bun:test";
import { formatRunDuration, turnRunMs } from "./turn-time";

describe("turnRunMs", () => {
  it("measures end minus start", () => {
    assert.equal(turnRunMs({ start: { time: 1_000 }, end: { time: 65_000 } }), 64_000);
  });

  it("is undefined while the turn is open", () => {
    assert.equal(turnRunMs({ start: { time: 1_000 } }), undefined);
  });

  it("is undefined before the turn starts", () => {
    assert.equal(turnRunMs({ end: { time: 1_000 } }), undefined);
    assert.equal(turnRunMs({}), undefined);
  });

  it("clamps negative spans to zero", () => {
    assert.equal(turnRunMs({ start: { time: 2_000 }, end: { time: 1_000 } }), 0);
  });
});

describe("formatRunDuration", () => {
  it("shows seconds only under a minute", () => {
    assert.equal(formatRunDuration(0), "0s");
    assert.equal(formatRunDuration(45_400), "45s");
  });

  it("pads the second field once minutes appear", () => {
    assert.equal(formatRunDuration(60_000), "1m 00s");
    assert.equal(formatRunDuration(83_000), "1m 23s");
    assert.equal(formatRunDuration(3_600_000), "60m 00s");
  });

  it("truncates sub-second remainders", () => {
    assert.equal(formatRunDuration(59_900), "59s");
  });
});
