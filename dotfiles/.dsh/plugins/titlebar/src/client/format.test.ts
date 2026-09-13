/**
 * Unit tests for the pure title formatting primitives.
 * Assertions use `node:assert/strict` (repo convention).
 */
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildTitle,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  splitMarkedTitle,
  WAITING_MARK,
} from "./format";

describe("spinnerFrame", () => {
  it("returns the frame at the current 100ms slot", () => {
    assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
    assert.equal(spinnerFrame(SPINNER_INTERVAL_MS), SPINNER_FRAMES[1]);
    assert.equal(spinnerFrame(SPINNER_INTERVAL_MS * 3 + 55), SPINNER_FRAMES[3]);
  });

  it("wraps around after the last frame", () => {
    assert.equal(spinnerFrame(SPINNER_INTERVAL_MS * SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
    assert.equal(
      spinnerFrame(SPINNER_INTERVAL_MS * (SPINNER_FRAMES.length + 1)),
      SPINNER_FRAMES[1],
    );
  });

  it("handles negative timestamps by shifting into range", () => {
    assert.equal(spinnerFrame(-50), SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
  });
});

describe("splitMarkedTitle", () => {
  it("returns a plain title untouched", () => {
    assert.deepEqual(splitMarkedTitle("My session — DeepSeek Harness"), {
      plain: "My session — DeepSeek Harness",
    });
  });

  it("splits a spinner-marked title", () => {
    const { mark, plain } = splitMarkedTitle(`${SPINNER_FRAMES[3]} My session — DeepSeek Harness`);
    assert.equal(mark, SPINNER_FRAMES[3]);
    assert.equal(plain, "My session — DeepSeek Harness");
  });

  it("splits the waiting mark", () => {
    const { mark, plain } = splitMarkedTitle(`${WAITING_MARK} DeepSeek Harness`);
    assert.equal(mark, WAITING_MARK);
    assert.equal(plain, "DeepSeek Harness");
  });

  it("does not treat a braille-prefixed base title as its own mark", () => {
    // The mark pattern requires the mark char followed by a space, so a
    // base title that merely starts with a braille char stays untouched.
    const base = "⠋-named session — DeepSeek Harness";
    assert.deepEqual(splitMarkedTitle(base), { plain: base });
  });
});

describe("buildTitle", () => {
  it("returns the plain title without a mark", () => {
    assert.equal(buildTitle(undefined, "DeepSeek Harness"), "DeepSeek Harness");
  });

  it("prefixes the mark with one space", () => {
    assert.equal(buildTitle(WAITING_MARK, "DeepSeek Harness"), `${WAITING_MARK} DeepSeek Harness`);
  });

  it("round-trips with splitMarkedTitle", () => {
    const marked = buildTitle(SPINNER_FRAMES[0], "My session — DeepSeek Harness");
    const { mark, plain } = splitMarkedTitle(marked);
    assert.equal(mark, SPINNER_FRAMES[0]);
    assert.equal(buildTitle(mark, plain), marked);
  });
});
