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
    assert.equal(line, "zai short 88% ↻ 2h30m · long 98% ↻ 7d00h00m");
  });

  it("renders an em dash for a window without a percentage", () => {
    const line = formatUsageLine(entryWith({ short: null, shortResetsAt: null }), NOW);
    assert.equal(line, "zai short — · long 98% ↻ 7d00h00m");
  });

  it("omits the countdown when the reset time is missing", () => {
    const line = formatUsageLine(entryWith({ longResetsAt: null }), NOW);
    assert.equal(line, "zai short 88% ↻ 2h30m · long 98%");
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
