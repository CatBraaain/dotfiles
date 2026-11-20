import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { DateTime } from "./datetime.ts";
import type { TriggerDef, TriggerKind } from "./def.ts";
import { buildTriggers, type CalendarTrigger, type TriggerXml } from "./trigger.ts";

const date = (y: number, mo: number, d: number): DateTime => ({ y, mo, d, h: 0, mi: 0, s: 0 });
const dt = (y: number, mo: number, d: number, h: number, mi: number): DateTime => ({
  y,
  mo,
  d,
  h,
  mi,
  s: 0,
});
const triggerDef = (kind: TriggerKind, value: string): TriggerDef => ({ kind, value });
const cron = (value: string) => triggerDef("cron", value);
const calendars = (triggers: TriggerXml[]): CalendarTrigger[] =>
  triggers.filter((t) => t.kind === "calendar") as CalendarTrigger[];
const build = (def: TriggerDef, now: DateTime) => buildTriggers(def, date(2026, 1, 15), now);

describe("trigger building", () => {
  it("daily every day at nine", () => {
    const cals = calendars(build(cron("00 09 * * *"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 15, 9, 0));
    assert.deepEqual(cals[0]!.repetition, null);
    assert.deepEqual(cals[0]!.schedule, { kind: "daily", daysInterval: 1 });
  });

  it("minute step with hour range uses repetition", () => {
    const cals = calendars(build(cron("*/15 9-17 * * *"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 15, 9, 0));
    assert.deepEqual(cals[0]!.repetition, ["PT15M", "PT9H"]);
  });

  it("every minute every hour is one trigger with day span", () => {
    const cals = calendars(build(cron("* * * * *"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    // StartBoundary 00:00 equals `now` 00:00, so the past-start correction
    // pushes it one day forward (spec: <= now).
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 16, 0, 0));
    assert.deepEqual(cals[0]!.repetition, ["PT1M", "PT24H"]);
  });

  it("hour list with every minute expands per hour", () => {
    const cals = calendars(build(cron("* 3,5,6 * * *"), dt(2026, 1, 15, 0, 0)));
    assert.deepEqual(
      cals.map((c) => c.startBoundary.h),
      [3, 5, 6],
    );
    assert.deepEqual(
      cals.map((c) => c.repetition),
      cals.map(() => ["PT1M", "PT1H"]),
    );
  });

  it("minute list with any hour expands per minute", () => {
    const cals = calendars(build(cron("3,6 * * * *"), dt(2026, 1, 15, 0, 0)));
    assert.deepEqual(
      cals.map((c) => c.startBoundary.mi),
      [3, 6],
    );
    assert.ok(cals.every((c) => c.repetition !== null && c.repetition[0] === "PT1H"));
    assert.ok(cals.every((c) => c.repetition !== null && c.repetition[1] === "PT24H"));
  });

  it("minute range with hour list uses minute repetition", () => {
    const cals = calendars(build(cron("3-33/6 3,6 * * *"), dt(2026, 1, 15, 0, 0)));
    const starts = cals.map(
      (c) =>
        `${String(c.startBoundary.h).padStart(2, "0")}:${String(c.startBoundary.mi).padStart(2, "0")}`,
    );
    assert.deepEqual(starts, ["03:03", "06:03"]);
    assert.deepEqual(
      cals.map((c) => c.repetition),
      cals.map(() => ["PT6M", "PT31M"]),
    );
  });

  it("minute list and hour list expand all combinations", () => {
    const cals = calendars(build(cron("0,30 9,21 * * *"), dt(2026, 1, 15, 0, 0)));
    const starts = cals.map(
      (c) =>
        `${String(c.startBoundary.h).padStart(2, "0")}:${String(c.startBoundary.mi).padStart(2, "0")}`,
    );
    assert.deepEqual(starts, ["09:00", "09:30", "21:00", "21:30"]);
    assert.ok(cals.every((c) => c.repetition === null));
  });

  it("day step becomes daily interval", () => {
    const cals = calendars(build(cron("0 12 */2 * *"), dt(2026, 1, 15, 0, 0)));
    assert.deepEqual(cals[0]!.schedule, { kind: "daily", daysInterval: 2 });
  });

  it("weekday list becomes weekly", () => {
    const cals = calendars(build(cron("0 12 * * MON,WED,FRI"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.schedule, { kind: "weekly", days: [1, 3, 5] });
  });

  it("month with star day becomes monthly all days", () => {
    const cals = calendars(build(cron("0 12 * JAN *"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.schedule, {
      kind: "monthly",
      days: Array.from({ length: 31 }, (_, i) => i + 1),
      months: [1],
    });
  });

  it("day list becomes monthly", () => {
    const cals = calendars(build(cron("0 12 1,15 * *"), dt(2026, 1, 15, 0, 0)));
    assert.deepEqual(cals[0]!.schedule, {
      kind: "monthly",
      days: [1, 15],
      months: Array.from({ length: 12 }, (_, i) => i + 1),
    });
  });

  it("day and weekday both set produce two triggers", () => {
    const cals = calendars(build(cron("0 12 1 * MON"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 2);
    assert.deepEqual(cals[0]!.schedule, {
      kind: "monthlyDow",
      days: [1],
      months: Array.from({ length: 12 }, (_, i) => i + 1),
    });
    assert.deepEqual(cals[1]!.schedule, {
      kind: "monthly",
      days: [1],
      months: Array.from({ length: 12 }, (_, i) => i + 1),
    });
  });

  it("weekday and month becomes monthly dow", () => {
    const cals = calendars(build(cron("0 12 * JAN MON"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.schedule, { kind: "monthlyDow", days: [1], months: [1] });
  });

  it("start boundary in past is pushed one day", () => {
    // now is 10:00; the 09:00 start is in the past -> Jan 16.
    const cals = calendars(build(cron("00 09 * * *"), dt(2026, 1, 15, 10, 0)));
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 16, 9, 0));
  });

  it("start boundary equal to now is pushed one day", () => {
    const cals = calendars(build(cron("00 09 * * *"), dt(2026, 1, 15, 9, 0)));
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 16, 9, 0));
  });

  it("past correction applies only to cron", () => {
    const once = build(triggerDef("once", "2020-01-01 09:00"), dt(2026, 1, 15, 12, 0));
    // Far in the past and left as-is: no correction for once.
    assert.equal(once[0]!.kind, "time");
    assert.deepEqual(
      once[0]!.kind === "time" ? once[0]!.startBoundary : null,
      dt(2020, 1, 1, 9, 0),
    );
  });

  it("every minute with hour range starts at range beginning", () => {
    const cals = calendars(build(cron("* 2-6 * * *"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 15, 2, 0));
    assert.deepEqual(cals[0]!.repetition, ["PT1M", "PT5H"]);
  });

  it("minute range with hour range expands every minute value", () => {
    const cals = calendars(build(cron("3-33 3-5 * * *"), dt(2026, 1, 15, 0, 0)));
    // Inefficient but faithful to the original: one trigger per minute value
    // (31), each repeating hourly for the hour-range span.
    assert.equal(cals.length, 31);
    assert.deepEqual(cals[0]!.startBoundary, dt(2026, 1, 15, 3, 3));
    assert.deepEqual(cals[0]!.repetition, ["PT1H", "PT3H"]);
  });

  it("minute step and hour step use minute repetition per hour", () => {
    const cals = calendars(build(cron("3/6 3/6 * * *"), dt(2026, 1, 15, 0, 0)));
    // Both fields are steps, so one trigger per hour value (3,9,15,21), each
    // repeating every 6 minutes for the minute-range span (3-59 -> 57).
    assert.equal(cals.length, 4);
    const starts = cals.map(
      (c) =>
        `${String(c.startBoundary.h).padStart(2, "0")}:${String(c.startBoundary.mi).padStart(2, "0")}`,
    );
    assert.deepEqual(starts, ["03:03", "09:03", "15:03", "21:03"]);
    assert.deepEqual(
      cals.map((c) => c.repetition),
      cals.map(() => ["PT6M", "PT57M"]),
    );
  });

  it("full dow range is treated as every day", () => {
    const cals = calendars(build(cron("0 12 * * 0-6"), dt(2026, 1, 15, 0, 0)));
    assert.equal(cals.length, 1);
    assert.deepEqual(cals[0]!.schedule, { kind: "daily", daysInterval: 1 });
  });

  it("startup delay converts to iso duration", () => {
    const triggers = build(triggerDef("startup", "01:30"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "logon", delay: "PT1H30M" });
  });

  it("boot delay with seconds", () => {
    const triggers = build(triggerDef("boot", "00:00:30"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "boot", delay: "PT30S" });
  });

  it("zero delay formats as PT0S", () => {
    const triggers = build(triggerDef("boot", "00:00"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "boot", delay: "PT0S" });
  });

  it("delay accepts hours above twenty three", () => {
    const triggers = build(triggerDef("startup", "25:00"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "logon", delay: "PT25H" });
  });

  it("rejects invalid delays", () => {
    for (const bad of ["9:00", "0130", "01:60", "01:00:60", "01"]) {
      assert.throws(
        () => build(triggerDef("startup", bad), dt(2026, 1, 15, 0, 0)),
        Error,
        `should reject ${bad}`,
      );
    }
  });

  it("once parses date only as midnight", () => {
    const triggers = build(triggerDef("once", "2000-01-01"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "time", startBoundary: dt(2000, 1, 1, 0, 0) });
  });

  it("once parses datetime with seconds", () => {
    const triggers = build(triggerDef("once", "2030-06-01 07:45:30"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], {
      kind: "time",
      startBoundary: { y: 2030, mo: 6, d: 1, h: 7, mi: 45, s: 30 },
    });
  });

  it("rejects invalid once values", () => {
    for (const bad of ["2000-13-01", "01-01-2000", "2000-01-01T09:00", "2000-01-01 9:00"]) {
      assert.throws(
        () => build(triggerDef("once", bad), dt(2026, 1, 15, 0, 0)),
        Error,
        `should reject ${bad}`,
      );
    }
  });

  it("now trigger is registration", () => {
    const triggers = build(triggerDef("now", "dummy"), dt(2026, 1, 15, 0, 0));
    assert.deepEqual(triggers[0], { kind: "registration" });
  });
});
