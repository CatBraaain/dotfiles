import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createRepetitionDetector, type RepetitionMatch } from "./detector.ts";

describe("stream repetition detector", () => {
  for (const period of [1, 16, 20, 100, 500]) {
    it(`detects the first eligible complete run with period ${period}`, () => {
      const repetitions = Math.max(10, Math.ceil(1000 / period));
      const pattern = distinctPattern(period);
      const detector = createRepetitionDetector();
      const run = pattern.repeat(repetitions);
      assert.equal(detector.push(run.slice(0, -1)), undefined);
      assert.deepEqual(detector.push(run.slice(-1)), {
        period,
        repetitions,
        repeatedCharacters: period * repetitions,
        endPosition: period * repetitions,
      });
    });
  }

  it("rejects a run whose only period is 501", () => {
    assert.equal(detect([distinctPattern(501).repeat(12)]), undefined);
  });

  it("requires both 1000 characters and ten complete copies", () => {
    const characters = createRepetitionDetector();
    assert.equal(characters.push("0".repeat(999)), undefined);
    assert.deepEqual(characters.push("0"), {
      period: 1,
      repetitions: 1000,
      repeatedCharacters: 1000,
      endPosition: 1000,
    });
    const copies = createRepetitionDetector();
    const pattern = distinctPattern(500);
    assert.equal(copies.push(pattern.repeat(9)), undefined);
    assert.equal(copies.push(pattern.slice(0, 499)), undefined);
    assert.equal(copies.push(pattern.slice(499))?.repetitions, 10);
  });

  it("finds a run after a prefix and before a nonrepeating suffix in one delta", () => {
    const prefix = "Ordinary output before a loop: ";
    assert.deepEqual(detect([prefix + "0".repeat(1000) + "the loop has ended"]), {
      period: 1,
      repetitions: 1000,
      repeatedCharacters: 1000,
      endPosition: prefix.length + 1000,
    });
  });

  it("chooses the shortest eligible period and counts only complete copies", () => {
    const input = "abc".repeat(400);
    assert.deepEqual(detect([input]), {
      period: 3,
      repetitions: 334,
      repeatedCharacters: 1002,
      endPosition: 1002,
    });
    assert.equal(
      detect([distinctPattern(16).repeat(62) + distinctPattern(16).slice(0, 8)]),
      undefined,
    );
  });

  it("is invariant under every two-part UTF-16 split", () => {
    const input = "prefix😀: " + ("😀" + distinctPattern(19)).repeat(50) + "tail";
    const expected = bruteForce(input);
    assert.ok(expected);
    for (let boundary = 0; boundary <= input.length; boundary++) {
      assert.deepEqual(
        detect([input.slice(0, boundary), input.slice(boundary)]),
        expected,
        `boundary=${boundary}`,
      );
    }
  });

  it("is invariant under single-code-unit and seeded random chunks", () => {
    const input = "prefix " + ("😀" + distinctPattern(15)).repeat(63) + "suffix";
    const expected = bruteForce(input);
    assert.deepEqual(detect(input.split("")), expected);
    const random = seededRandom(0x19a17);
    for (let trial = 0; trial < 20; trial++) {
      assert.deepEqual(detect(randomChunks(input, random)), expected, `trial=${trial}`);
    }
  });

  it("buffers split surrogate pairs and ignores empty deltas", () => {
    const detector = createRepetitionDetector();
    assert.equal(detector.push("😀".repeat(999) + "\ud83d"), undefined);
    assert.equal(detector.push(""), undefined);
    assert.deepEqual(detector.push("\ude00"), {
      period: 1,
      repetitions: 1000,
      repeatedCharacters: 1000,
      endPosition: 1000,
    });
  });

  it("flushes a trailing unpaired high surrogate exactly once", () => {
    const detector = createRepetitionDetector();
    assert.equal(detector.push("\ud800".repeat(1000)), undefined);
    assert.equal(detector.push(""), undefined);
    const match = detector.finish();
    assert.deepEqual(match, {
      period: 1,
      repetitions: 1000,
      repeatedCharacters: 1000,
      endPosition: 1000,
    });
    assert.strictEqual(detector.finish(), match);
  });

  it("treats unpaired low surrogates and highs followed by nonlows as characters", () => {
    assert.equal(detect(["\udc00".repeat(1000)])?.endPosition, 1000);
    const input = "\ud800x\udc00".repeat(334);
    assert.deepEqual(detect(input.split("")), bruteForce(input));
    assert.equal(detect(["\ud800".repeat(999), "x"]), undefined);
  });

  it("preserves exact whitespace, case, normalization and serialized escape spelling", () => {
    for (const pattern of [" A\na ", "é e\u0301 ", "\\u3042"]) {
      const input = pattern.repeat(Math.ceil(1000 / Array.from(pattern).length));
      assert.deepEqual(detect([input]), bruteForce(input));
    }
    assert.equal(detect(["a".repeat(999) + "A"]), undefined);
    assert.equal(detect(["é".repeat(999) + "e\u0301"]), undefined);
  });

  it("continues through normal text and long nonrepeating streams", () => {
    const random = seededRandom(73);
    const normalText = Array.from({ length: 20000 }, () =>
      String.fromCodePoint(32 + Math.floor(random() * 90)),
    ).join("");
    assert.equal(detect(randomChunks(normalText, random)), undefined);
    assert.equal(detect([distinctPattern(501).repeat(600)]), undefined);
    assert.equal(detect([""]), undefined);
  });

  it("latches the same match without consuming a large suffix", () => {
    const detector = createRepetitionDetector();
    const match = detector.push("0".repeat(300000));
    assert.equal(match?.endPosition, 1000);
    assert.strictEqual(detector.push("unrelated suffix"), match);
    assert.strictEqual(detector.push(""), match);
    assert.strictEqual(detector.finish(), match);
  });

  it("keeps lag counters and surrogate buffering independent between instances", () => {
    const first = createRepetitionDetector();
    const second = createRepetitionDetector();
    assert.equal(first.push("😀".repeat(999) + "\ud83d"), undefined);
    assert.equal(second.push("\ude00".repeat(999)), undefined);
    assert.equal(first.push("\ude00")?.period, 1);
    assert.equal(second.finish(), undefined);
    assert.equal(second.push("\ude00")?.endPosition, 1000);
    assert.equal(createRepetitionDetector().push("0"), undefined);
  });

  it("agrees with an independent brute-force oracle on seeded complete and interrupted runs", () => {
    const random = seededRandom(0xc0ffee);
    const periods = [1, 2, 3, 7, 16, 20, 99, 100, 101, 127, 250, 499, 500, 501];
    for (const period of periods) {
      const pattern = distinctPattern(period);
      const copies = Math.max(10, Math.ceil(1000 / period));
      const prefix = Array.from({ length: 17 }, () =>
        String.fromCharCode(65 + Math.floor(random() * 26)),
      ).join("");
      for (const run of [
        pattern.repeat(copies),
        pattern.repeat(copies).slice(0, -1),
        pattern.repeat(copies - 1) + "!",
      ]) {
        const input = prefix + run + "end";
        assert.deepEqual(
          detect(randomChunks(input, random)),
          bruteForce(input),
          `period=${period}, length=${input.length}`,
        );
      }
    }
    for (let trial = 0; trial < 40; trial++) {
      const pattern = Array.from(
        { length: 1 + Math.floor(random() * 30) },
        () => "abc😀"[Math.floor(random() * 5)]!,
      ).join("");
      const run = pattern.repeat(1100);
      const interruption = 850 + Math.floor(random() * 350);
      const input = run.slice(0, interruption) + "!" + run.slice(interruption, 2300);
      assert.deepEqual(detect(randomChunks(input, random)), bruteForce(input), `trial=${trial}`);
    }
  });
});

function detect(chunks: string[]): RepetitionMatch | undefined {
  const detector = createRepetitionDetector();
  for (const chunk of chunks) detector.push(chunk);
  return detector.finish();
}

function distinctPattern(period: number): string {
  return Array.from({ length: period }, (_, index) => String.fromCodePoint(0x100 + index)).join("");
}

function bruteForce(input: string): RepetitionMatch | undefined {
  const characters = Array.from(input);
  for (let end = 1000; end <= characters.length; end++) {
    for (let period = 1; period <= Math.min(500, Math.floor(end / 10)); period++) {
      const repetitions = Math.max(10, Math.ceil(1000 / period));
      const repeatedCharacters = period * repetitions;
      if (repeatedCharacters > end) continue;
      const start = end - repeatedCharacters;
      let isRepeated = true;
      for (let offset = period; offset < repeatedCharacters; offset++) {
        if (characters[start + offset] !== characters[start + (offset % period)]) {
          isRepeated = false;
          break;
        }
      }
      if (isRepeated) return { period, repetitions, repeatedCharacters, endPosition: end };
    }
  }
  return undefined;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChunks(input: string, random: () => number): string[] {
  const chunks: string[] = [""];
  for (let offset = 0; offset < input.length;) {
    const size = 1 + Math.floor(random() * 37);
    chunks.push(input.slice(offset, offset + size));
    offset += size;
  }
  chunks.push("");
  return chunks;
}
