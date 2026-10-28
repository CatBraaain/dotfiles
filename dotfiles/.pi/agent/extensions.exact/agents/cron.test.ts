import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { cronMatches, parseCronExpression } from "./cron.ts";

// 2026-10-28 is a Wednesday. All dates below are constructed in UTC.
const WEDNESDAY = { year: 2026, monthIndex: 9, day: 28 };
const SUNDAY = { year: 2026, monthIndex: 9, day: 25 };

function utcMoment(
  date: { year: number; monthIndex: number; day: number },
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(date.year, date.monthIndex, date.day, hour, minute));
}

function matchesAt(expression: string, moment: Date): boolean {
  return cronMatches(parseCronExpression(expression), moment);
}

describe("cron matching", () => {
  it("matches * in every field at any moment", () => {
    assert.equal(matchesAt("* * * * *", utcMoment(WEDNESDAY, 6, 30)), true);
    assert.equal(matchesAt("* * * * *", utcMoment(SUNDAY, 23, 59)), true);
  });

  it("matches single numbers in each field", () => {
    assert.equal(matchesAt("30 6 28 10 3", utcMoment(WEDNESDAY, 6, 30)), true);
    assert.equal(matchesAt("31 6 28 10 3", utcMoment(WEDNESDAY, 6, 30)), false);
    assert.equal(matchesAt("30 7 28 10 3", utcMoment(WEDNESDAY, 6, 30)), false);
    assert.equal(matchesAt("30 6 29 10 3", utcMoment(WEDNESDAY, 6, 30)), false);
    assert.equal(matchesAt("30 6 28 11 3", utcMoment(WEDNESDAY, 6, 30)), false);
    assert.equal(matchesAt("30 6 28 10 4", utcMoment(WEDNESDAY, 6, 30)), false);
  });

  it("matches ranges a-b including both ends", () => {
    assert.equal(matchesAt("* 6-9 * * 1-5", utcMoment(WEDNESDAY, 6, 0)), true);
    assert.equal(matchesAt("* 6-9 * * 1-5", utcMoment(WEDNESDAY, 9, 59)), true);
    assert.equal(matchesAt("* 6-9 * * 1-5", utcMoment(WEDNESDAY, 5, 59)), false);
    assert.equal(matchesAt("* 6-9 * * 1-5", utcMoment(WEDNESDAY, 10, 0)), false);
    assert.equal(matchesAt("* 6-9 * * 1-5", utcMoment(SUNDAY, 7, 0)), false);
  });

  it("matches lists a,b", () => {
    assert.equal(matchesAt("0,30 * * * *", utcMoment(WEDNESDAY, 6, 0)), true);
    assert.equal(matchesAt("0,30 * * * *", utcMoment(WEDNESDAY, 6, 30)), true);
    assert.equal(matchesAt("0,30 * * * *", utcMoment(WEDNESDAY, 6, 15)), false);
    assert.equal(matchesAt("* 1,3 * * *", utcMoment(WEDNESDAY, 3, 0)), true);
    assert.equal(matchesAt("* 1,3 * * *", utcMoment(WEDNESDAY, 2, 0)), false);
  });

  it("matches steps */n and a-b/n", () => {
    assert.equal(matchesAt("*/15 * * * *", utcMoment(WEDNESDAY, 6, 0)), true);
    assert.equal(matchesAt("*/15 * * * *", utcMoment(WEDNESDAY, 6, 45)), true);
    assert.equal(matchesAt("*/15 * * * *", utcMoment(WEDNESDAY, 6, 20)), false);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 4, 0)), true);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 10, 0)), true);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 16, 0)), true);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 5, 0)), false);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 20, 0)), false);
    assert.equal(matchesAt("* 4-20/6 * * *", utcMoment(WEDNESDAY, 21, 0)), false);
  });

  it("treats weekday 7 as equivalent to 0 (Sunday)", () => {
    // 2026-10-30 is a Friday.
    const friday = { year: 2026, monthIndex: 9, day: 30 };
    assert.equal(matchesAt("* * * * 0", utcMoment(SUNDAY, 12, 0)), true);
    assert.equal(matchesAt("* * * * 7", utcMoment(SUNDAY, 12, 0)), true);
    assert.equal(matchesAt("* * * * 7", utcMoment(WEDNESDAY, 12, 0)), false);
    assert.equal(matchesAt("* * * * 5-7", utcMoment(SUNDAY, 12, 0)), true);
    assert.equal(matchesAt("* * * * 5-7", utcMoment(friday, 12, 0)), true);
    assert.equal(matchesAt("* * * * 5-7", utcMoment(WEDNESDAY, 12, 0)), false);
  });

  it("requires every field to match at the same moment", () => {
    assert.equal(
      matchesAt("0 0 1 1 *", utcMoment({ year: 2026, monthIndex: 0, day: 1 }, 0, 0)),
      true,
    );
    assert.equal(
      matchesAt("0 0 1 1 *", utcMoment({ year: 2026, monthIndex: 0, day: 1 }, 0, 1)),
      false,
    );
    assert.equal(
      matchesAt("0 0 1 1 *", utcMoment({ year: 2026, monthIndex: 0, day: 2 }, 0, 0)),
      false,
    );
  });

  it("evaluates field boundaries at UTC instants", () => {
    // 2026-10-28T23:59Z is still Wednesday; one minute later the UTC weekday
    // and hour roll over together.
    const wednesdayLate = utcMoment(WEDNESDAY, 23, 59);
    const thursdayStart = utcMoment({ year: 2026, monthIndex: 9, day: 29 }, 0, 0);
    assert.equal(matchesAt("* 23 * * 3", wednesdayLate), true);
    assert.equal(
      matchesAt("59 23 31 12 *", utcMoment({ year: 2026, monthIndex: 11, day: 31 }, 23, 59)),
      true,
    );
    assert.equal(
      matchesAt("0 0 1 1 *", utcMoment({ year: 2027, monthIndex: 0, day: 1 }, 0, 0)),
      true,
    );
    assert.equal(matchesAt("* 0 * * 4", thursdayStart), true);
    assert.equal(matchesAt("* 23 * * 3", thursdayStart), false);
  });
});

describe("cron validation", () => {
  it("rejects expressions without exactly 5 fields", () => {
    assert.throws(() => parseCronExpression("* * * *"), /must have 5 fields/);
    assert.throws(() => parseCronExpression("* * * * * *"), /must have 5 fields/);
    assert.throws(() => parseCronExpression(""), /must have 5 fields/);
    assert.throws(() => parseCronExpression("  "), /must have 5 fields/);
  });

  it("rejects names and macros", () => {
    assert.throws(() => parseCronExpression("@daily"), /must have 5 fields/);
    assert.throws(() => parseCronExpression("* * * JAN *"), /invalid cron month field/);
    assert.throws(() => parseCronExpression("* * * * SUN"), /invalid cron weekday field/);
    assert.throws(() => parseCronExpression("* * * * mon-fri"), /invalid cron weekday field/);
  });

  it("rejects values outside each field's range", () => {
    assert.throws(() => parseCronExpression("60 * * * *"), /minute value 60 is out of range/);
    assert.throws(() => parseCronExpression("* 24 * * *"), /hour value 24 is out of range/);
    assert.throws(() => parseCronExpression("* * 0 * *"), /day value 0 is out of range/);
    assert.throws(() => parseCronExpression("* * 32 * *"), /day value 32 is out of range/);
    assert.throws(() => parseCronExpression("* * * 0 *"), /month value 0 is out of range/);
    assert.throws(() => parseCronExpression("* * * 13 *"), /month value 13 is out of range/);
    assert.throws(() => parseCronExpression("* * * * 8"), /weekday value 8 is out of range/);
  });

  it("rejects ranges whose start exceeds their end", () => {
    assert.throws(() => parseCronExpression("50-10 * * * *"), /range start exceeds its end/);
    assert.throws(() => parseCronExpression("* 20-5 * * *"), /range start exceeds its end/);
    assert.throws(() => parseCronExpression("* * 20-10 * *"), /range start exceeds its end/);
  });

  it("rejects invalid steps", () => {
    assert.throws(() => parseCronExpression("*/0 * * * *"), /step must be 1 or greater/);
    assert.throws(() => parseCronExpression("5/10 * * * *"), /step requires a range or \*/);
    assert.throws(() => parseCronExpression("*-5 * * * *"), /range cannot start with \*/);
  });

  it("rejects malformed items", () => {
    assert.throws(() => parseCronExpression("1,,2 * * * *"), /invalid cron minute field/);
    assert.throws(() => parseCronExpression("a * * * *"), /invalid cron minute field/);
    assert.throws(() => parseCronExpression("1- * * * *"), /invalid cron minute field/);
    assert.throws(() => parseCronExpression("1.5 * * * *"), /invalid cron minute field/);
    assert.throws(() => parseCronExpression("-5 * * * *"), /invalid cron minute field/);
  });

  it("accepts equal range ends and single-value lists", () => {
    assert.doesNotThrow(() => parseCronExpression("5-5 * * * *"));
    assert.doesNotThrow(() => parseCronExpression("5,5 * * * *"));
    assert.equal(matchesAt("5-5 * * * *", utcMoment(WEDNESDAY, 6, 5)), true);
  });
});
