import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { onChordKey, type ChordState } from "./chord.ts";

const CTRL_K = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
const CTRL_M = { key: "m", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
const PLAIN_A = { key: "a", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const T0 = 1_000_000;

function armed(at: number): ChordState {
  return { armedAt: at };
}

describe("onChordKey", () => {
  it("arms on Ctrl+K from idle and swallows it (Ctrl+K alone does nothing)", () => {
    assert.deepEqual(onChordKey({}, CTRL_K, T0), {
      state: { armedAt: T0 },
      open: false,
      swallow: true,
    });
  });

  it("opens when Ctrl+M arrives within the window", () => {
    assert.deepEqual(onChordKey(armed(T0), CTRL_M, T0 + 900), {
      state: {},
      open: true,
      swallow: true,
    });
  });

  it("still counts the chord at exactly 1000ms elapsed", () => {
    assert.deepEqual(onChordKey(armed(T0), CTRL_M, T0 + 1000), {
      state: {},
      open: true,
      swallow: true,
    });
  });

  it("times out past 1000ms: Ctrl+M is treated as plain input", () => {
    assert.deepEqual(onChordKey(armed(T0), CTRL_M, T0 + 1001), {
      state: {},
      open: false,
      swallow: false,
    });
  });

  it("disarms on any other key within the window", () => {
    assert.deepEqual(onChordKey(armed(T0), PLAIN_A, T0 + 100), {
      state: {},
      open: false,
      swallow: false,
    });
  });

  it("does nothing from idle on keys other than Ctrl+K", () => {
    const idle: ChordState = {};
    assert.deepEqual(onChordKey(idle, PLAIN_A, T0), { state: {}, open: false, swallow: false });
    assert.deepEqual(onChordKey(idle, CTRL_M, T0), { state: {}, open: false, swallow: false });
  });

  it("re-arms when Ctrl+K arrives while already armed", () => {
    assert.deepEqual(onChordKey(armed(T0), CTRL_K, T0 + 100), {
      state: { armedAt: T0 + 100 },
      open: false,
      swallow: true,
    });
  });

  it("ignores modifier combinations that are not plain Ctrl", () => {
    const shiftK = { ...CTRL_K, shiftKey: true };
    assert.deepEqual(onChordKey({}, shiftK, T0), { state: {}, open: false, swallow: false });
    const cmdM = { ...CTRL_M, metaKey: true };
    assert.deepEqual(onChordKey(armed(T0), cmdM, T0 + 10), {
      state: {},
      open: false,
      swallow: false,
    });
  });
});
