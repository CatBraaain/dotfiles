import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  buildUsageWidgetLines,
  formatRelativeTime,
  formatUsageLine,
  parseUsageJson,
  type UsageEntry,
} from "./index";

const NOW = Date.parse("2026-10-26T12:00:00+09:00");

const minutesLater = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const entryWith = (overrides: Partial<UsageEntry>): UsageEntry => ({
  provider: "zai",
  short: 88,
  shortResetsAt: minutesLater(150),
  long: 98,
  longResetsAt: minutesLater(7 * 24 * 60),
  ...overrides,
});

describe("formatRelativeTime", () => {
  it("formats minutes only for less than an hour", () => {
    assert.equal(formatRelativeTime(minutesLater(30), NOW), "30m");
  });

  it("formats hours and minutes for less than a day", () => {
    assert.equal(formatRelativeTime(minutesLater(90), NOW), "1h30m");
  });

  it("pads minutes below ten when hours are present", () => {
    assert.equal(formatRelativeTime(minutesLater(65), NOW), "1h05m");
  });

  it("keeps zero minutes for an exact hour", () => {
    assert.equal(formatRelativeTime(minutesLater(120), NOW), "2h00m");
  });

  it("formats days, hours, and minutes for a day or more", () => {
    assert.equal(formatRelativeTime(minutesLater(5 * 24 * 60 + 14 * 60 + 10), NOW), "5d14h10m");
  });

  it("pads hours and minutes below ten when days are present", () => {
    assert.equal(formatRelativeTime(minutesLater(25 * 60 + 5), NOW), "1d01h05m");
  });

  it("keeps zero hours and minutes for an exact day", () => {
    assert.equal(formatRelativeTime(minutesLater(5 * 24 * 60), NOW), "5d00h00m");
  });

  it("rounds a partial minute up across a day boundary", () => {
    assert.equal(formatRelativeTime(minutesLater(24 * 60 - 0.5), NOW), "1d00h00m");
  });

  it("omits absent upper units for a single minute", () => {
    assert.equal(formatRelativeTime(minutesLater(1), NOW), "1m");
  });

  it("shows 0m for an already expired reset", () => {
    assert.equal(formatRelativeTime(minutesLater(-1), NOW), "0m");
  });

  it("shows ? for an unparseable reset time", () => {
    assert.equal(formatRelativeTime("not-a-date", NOW), "?");
  });
});

describe("formatUsageLine", () => {
  it("renders both windows with percentages and reset countdowns", () => {
    const line = formatUsageLine(entryWith({}), NOW);
    assert.equal(line, "zai | short  88% ↻ 2h30m | long  98% ↻ 7d00h00m");
  });

  it("renders an em dash for a window without a percentage", () => {
    const line = formatUsageLine(entryWith({ short: null, shortResetsAt: null }), NOW);
    assert.equal(line, "zai | short    — | long  98% ↻ 7d00h00m");
  });

  it("omits the countdown when the reset time is missing", () => {
    const line = formatUsageLine(entryWith({ longResetsAt: null }), NOW);
    assert.equal(line, "zai | short  88% ↻ 2h30m | long  98%");
  });

  it("maps known provider ids to short labels", () => {
    const line = formatUsageLine(entryWith({ provider: "openai-codex" }), NOW);
    assert.equal(line.startsWith("codex "), true);
  });

  it("keeps unknown provider ids as-is", () => {
    const line = formatUsageLine(entryWith({ provider: "openrouter" }), NOW);
    assert.equal(line.startsWith("openrouter "), true);
  });
});

describe("buildUsageWidgetLines", () => {
  it("returns one line per provider", () => {
    const lines = buildUsageWidgetLines(
      [entryWith({}), entryWith({ provider: "openai-codex" })],
      NOW,
    );
    assert.equal(lines?.length, 2);
  });

  it("aligns providers, percentages, resets, and pipe separators across all rows", () => {
    const lines = buildUsageWidgetLines(
      [
        entryWith({
          provider: "openai-codex",
          short: null,
          shortResetsAt: null,
          long: 76,
          longResetsAt: minutesLater(5 * 24 * 60 + 19 * 60),
        }),
        entryWith({
          provider: "command-code",
          short: 100,
          shortResetsAt: minutesLater(5 * 24 * 60 + 20 * 60),
          long: 100,
          longResetsAt: minutesLater(28 * 24 * 60 + 13 * 60),
        }),
        entryWith({
          short: 0,
          shortResetsAt: minutesLater(4),
          long: 64,
          longResetsAt: minutesLater(5 * 24 * 60 + 14 * 60),
        }),
      ],
      NOW,
    );
    assert.deepEqual(lines, [
      "codex   | short    —            | long  76% ↻  5d19h00m",
      "command | short 100% ↻ 5d20h00m | long 100% ↻ 28d13h00m",
      "zai     | short   0% ↻       4m | long  64% ↻  5d14h00m",
    ]);
  });

  it("reserves reset columns for missing timestamps and percentages", () => {
    const lines = buildUsageWidgetLines(
      [
        entryWith({ shortResetsAt: null, long: null }),
        entryWith({ provider: "openai-codex", longResetsAt: minutesLater(4) }),
      ],
      NOW,
    );
    assert.deepEqual(lines, [
      "zai   | short  88%         | long    —",
      "codex | short  88% ↻ 2h30m | long  98% ↻ 4m",
    ]);
  });

  it("omits reset column spacing when every reset is missing", () => {
    const lines = buildUsageWidgetLines(
      [
        entryWith({ short: null, shortResetsAt: null, longResetsAt: null }),
        entryWith({ provider: "command-code", shortResetsAt: null, longResetsAt: null }),
      ],
      NOW,
    );
    assert.deepEqual(lines, [
      "zai     | short    — | long  98%",
      "command | short  88% | long  98%",
    ]);
  });

  it("sizes the provider column using unknown labels and visible terminal widths", () => {
    const lines = buildUsageWidgetLines(
      [
        entryWith({ provider: "openrouter", shortResetsAt: null, longResetsAt: null }),
        entryWith({ provider: "ＡＰＩ", shortResetsAt: null, longResetsAt: null }),
      ],
      NOW,
    );
    assert.deepEqual(lines, [
      "openrouter | short  88% | long  98%",
      "ＡＰＩ     | short  88% | long  98%",
    ]);
  });

  it("aligns invalid and expired reset times with valid countdowns", () => {
    const lines = buildUsageWidgetLines(
      [
        entryWith({ shortResetsAt: "not-a-date", longResetsAt: minutesLater(-1) }),
        entryWith({ shortResetsAt: minutesLater(65), longResetsAt: minutesLater(60) }),
      ],
      NOW,
    );
    assert.deepEqual(lines, [
      "zai | short  88% ↻     ? | long  98% ↻    0m",
      "zai | short  88% ↻ 1h05m | long  98% ↻ 1h00m",
    ]);
  });

  it("returns undefined for no providers", () => {
    assert.equal(buildUsageWidgetLines([], NOW), undefined);
  });
});

describe("parseUsageJson", () => {
  it("parses the usage-cli JSON output", () => {
    const stdout = JSON.stringify([
      {
        provider: "openai-codex",
        short: null,
        shortResetsAt: null,
        long: 100,
        longResetsAt: minutesLater(60),
      },
      {
        provider: "zai",
        short: 88,
        shortResetsAt: minutesLater(150),
        long: 98,
        longResetsAt: null,
      },
    ]);
    const entries = parseUsageJson(stdout);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.short, 88);
    assert.equal(entries[1]?.longResetsAt, null);
  });

  it("returns no entries for invalid JSON", () => {
    assert.deepEqual(parseUsageJson("not json"), []);
  });

  it("returns no entries when a field has the wrong type", () => {
    const stdout = JSON.stringify([
      { provider: 1, short: null, shortResetsAt: null, long: 100, longResetsAt: null },
    ]);
    assert.deepEqual(parseUsageJson(stdout), []);
  });

  it("returns no entries when the root is not an array", () => {
    assert.deepEqual(parseUsageJson("{}"), []);
  });
});
