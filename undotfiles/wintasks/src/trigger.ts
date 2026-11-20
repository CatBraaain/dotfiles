// Trigger definitions converted to Task Scheduler trigger shapes.

import {
  DAY,
  DOW,
  HOUR,
  MINUTE,
  MONTH,
  fieldFirst,
  fieldIncr,
  fieldSpan,
  fieldValues,
  isEvery,
  isRange,
  isStar,
  isStep,
  parseCron,
  type CronSpec,
  type Field,
} from "./cron.ts";
import { addDays, isAfter, dateTime, validDate, type DateTime } from "./datetime.ts";
import type { TriggerDef } from "./def.ts";

export type ScheduleKind =
  | { kind: "daily"; daysInterval: number }
  | { kind: "weekly"; days: number[] }
  | { kind: "monthly"; days: number[]; months: number[] }
  | { kind: "monthlyDow"; days: number[]; months: number[] };

export interface CalendarTrigger {
  startBoundary: DateTime;
  repetition: [string, string] | null;
  schedule: ScheduleKind;
}

export type TriggerXml =
  | {
      kind: "calendar";
      startBoundary: DateTime;
      repetition: [string, string] | null;
      schedule: ScheduleKind;
    }
  | { kind: "logon"; delay: string }
  | { kind: "boot"; delay: string }
  | { kind: "time"; startBoundary: DateTime }
  | { kind: "registration" };

export function buildTriggers(trigger: TriggerDef, today: DateTime, now: DateTime): TriggerXml[] {
  switch (trigger.kind) {
    case "cron": {
      const spec = parseCron(trigger.value);
      return buildCalendarTriggers(spec, today, now);
    }
    case "startup":
      return [{ kind: "logon", delay: parseDelay(trigger.value, "startup") }];
    case "boot":
      return [{ kind: "boot", delay: parseDelay(trigger.value, "boot") }];
    case "once":
      return [{ kind: "time", startBoundary: parseOnce(trigger.value) }];
    case "now":
      return [{ kind: "registration" }];
  }
}

function buildCalendarTriggers(spec: CronSpec, today: DateTime, now: DateTime): TriggerXml[] {
  const triggers: TriggerXml[] = [];
  for (const schedule of selectSchedules(spec)) {
    for (const [start, repetition] of expandTimes(spec, today)) {
      // StartBoundary in the past is pushed one day forward, once, and only
      // for cron triggers (spec).
      const startBoundary = isAfter(start, now) ? start : addDays(start, 1);
      triggers.push({ kind: "calendar", startBoundary, repetition, schedule });
    }
  }
  return triggers;
}

// Base trigger selection by day/month/weekday patterns; day+weekday
// constraints fire independently (OR semantics).
function selectSchedules(spec: CronSpec): ScheduleKind[] {
  const dowEvery = isEvery(spec.dow);
  const dayStar = isStar(spec.day);
  const monthStar = isStar(spec.month);
  // A star month still writes all twelve month elements (equivalent to no
  // constraint, but always valid against the Task Scheduler schema).
  const months = () => (monthStar ? range(1, 12) : fieldValues(spec.month, MONTH[0], MONTH[1]));
  const kinds: ScheduleKind[] = [];
  if (dayStar && monthStar && !dowEvery) {
    kinds.push({ kind: "weekly", days: fieldValues(spec.dow, DOW[0], DOW[1]) });
  }
  if (!isStar(spec.dow) && (!dayStar || !monthStar)) {
    kinds.push({
      kind: "monthlyDow",
      days: fieldValues(spec.dow, DOW[0], DOW[1]),
      months: months(),
    });
  }
  if (!dayStar || (!monthStar && dowEvery)) {
    kinds.push({ kind: "monthly", days: fieldValues(spec.day, DAY[0], DAY[1]), months: months() });
  }
  if (dayStar && monthStar && dowEvery) {
    kinds.push({ kind: "daily", daysInterval: fieldIncr(spec.day) });
  }
  return kinds;
}

// Time-of-day expansion. Each element is (start datetime, repetition).
function expandTimes(spec: CronSpec, today: DateTime): Array<[DateTime, [string, string] | null]> {
  const min = spec.minute;
  const hour = spec.hour;
  const at = (h: number, m: number): DateTime => dateTime(today.y, today.mo, today.d, h, m);
  const [minLo, minHi] = MINUTE;
  const [hourLo, hourHi] = HOUR;
  const everyMinute = (f: Field) => `PT${fieldIncr(f)}M`;
  const hoursSpan = `PT${fieldSpan(hour, hourLo, hourHi)}H`;

  if (isStar(min) && (isEvery(hour) || isRange(hour))) {
    return [[at(fieldFirst(hour, hourLo), 0), [everyMinute(min), hoursSpan]]];
  }
  if (isStar(min)) {
    return fieldValues(hour, hourLo, hourHi).map(
      (h) => [at(h, 0), [everyMinute(min), "PT1H"]] as [DateTime, [string, string]],
    );
  }
  if (isEvery(hour) || isRange(hour)) {
    return fieldValues(min, minLo, minHi).map(
      (m) => [at(fieldFirst(hour, hourLo), m), ["PT1H", hoursSpan]] as [DateTime, [string, string]],
    );
  }
  if (isRange(min) || isStep(min)) {
    return fieldValues(hour, hourLo, hourHi).map(
      (h) =>
        [
          at(h, fieldFirst(min, minLo)),
          [everyMinute(min), `PT${fieldSpan(min, minLo, minHi)}M`],
        ] as [DateTime, [string, string]],
    );
  }
  const out: Array<[DateTime, [string, string] | null]> = [];
  for (const h of fieldValues(hour, hourLo, hourHi)) {
    for (const m of fieldValues(min, minLo, minHi)) {
      out.push([at(h, m), null]);
    }
  }
  return out;
}

function range(lo: number, hi: number): number[] {
  const values: number[] = [];
  for (let v = lo; v <= hi; v++) values.push(v);
  return values;
}

// `HH:MM` or `HH:MM:SS` -> ISO 8601 duration (e.g. PT1H30M).
function parseDelay(value: string, kind: string): string {
  const parts = value.split(":");
  const invalid = () =>
    new Error(`invalid ${kind} trigger value \`${value}\`: expected HH:MM or HH:MM:SS`);
  const twoDigits = (s: string): number | null => {
    if (s.length === 2 && /^\d\d$/.test(s)) return Number(s);
    return null;
  };
  let h: number | null = null;
  let m: number | null = null;
  let s: number | null = null;
  if (parts.length === 2) {
    h = twoDigits(parts[0]!);
    m = twoDigits(parts[1]!);
    s = 0;
  } else if (parts.length === 3) {
    h = twoDigits(parts[0]!);
    m = twoDigits(parts[1]!);
    s = twoDigits(parts[2]!);
  }
  if (h === null || m === null || s === null || m >= 60 || s >= 60) throw invalid();
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (s > 0) out += `${s}S`;
  if (out === "PT") out += "0S";
  return out;
}

// `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`; omitted time parts are zero.
function parseOnce(value: string): DateTime {
  const invalid = () =>
    new Error(
      `invalid once trigger value \`${value}\`: expected YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]`,
    );
  const spaceIndex = value.indexOf(" ");
  const datePart = spaceIndex === -1 ? value : value.slice(0, spaceIndex);
  const timePart = spaceIndex === -1 ? null : value.slice(spaceIndex + 1);
  const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
  if (!dateMatch) throw invalid();
  const y = Number(dateMatch[1]);
  const mo = Number(dateMatch[2]);
  const d = Number(dateMatch[3]);
  if (!validDate(y, mo, d)) throw invalid();
  let h = 0;
  let mi = 0;
  let s = 0;
  if (timePart !== null) {
    const seconds = timePart.split(":");
    if (seconds.length === 2) {
      h = fastTwoDigits(seconds[0]!);
      mi = fastTwoDigits(seconds[1]!);
      s = 0;
    } else if (seconds.length === 3) {
      h = fastTwoDigits(seconds[0]!);
      mi = fastTwoDigits(seconds[1]!);
      s = fastTwoDigits(seconds[2]!);
    } else {
      throw invalid();
    }
    if (h >= 24 || mi >= 60 || s >= 60) throw invalid();
  }
  return { y, mo, d, h, mi, s };
}

function fastTwoDigits(s: string): number {
  if (s.length === 2 && /^\d\d$/.test(s)) return Number(s);
  throw new Error(`invalid time component \`${s}\`: expected two digits`);
}

export function weekdayElement(dow: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow]!;
}

export function monthElement(month: number): string {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][month - 1]!;
}
