// cron — standard 5-field cron expressions for settings rules. Fields are
// minute, hour, day-of-month, month, and day-of-week, evaluated against the
// current UTC time. Supported item syntax per field: numbers, *, ranges (a-b),
// lists (a,b), and steps (* /n and a-b/n). Names (JAN/SUN) and macros
// (@daily) are rejected. Weekday 7 is equivalent to 0 (Sunday); no other
// special rules apply, so a moment matches only when all five fields match.

export interface CronSchedule {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly day: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly weekday: ReadonlySet<number>;
}

interface CronFieldRange {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const CRON_FIELD_RANGES: readonly CronFieldRange[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 7 },
];

const CRON_FIELD_ITEM = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

function parseCronValue(raw: string, range: CronFieldRange): number {
  const value = Number(raw);
  if (value < range.min || value > range.max) {
    throw new Error(`cron ${range.name} value ${raw} is out of range ${range.min}-${range.max}`);
  }
  return value;
}

function parseCronStep(raw: string, range: CronFieldRange): number {
  const step = Number(raw);
  if (step < 1) {
    throw new Error(`cron ${range.name} step must be 1 or greater: ${raw}`);
  }
  return step;
}

function parseCronField(field: string, range: CronFieldRange): Set<number> {
  const allowed = new Set<number>();
  for (const item of field.split(",")) {
    const match = CRON_FIELD_ITEM.exec(item);
    if (match === null) {
      throw new Error(`invalid cron ${range.name} field: ${JSON.stringify(field)}`);
    }
    const [, rawStart, rawEnd, rawStep] = match;
    const isAsterisk = rawStart === "*";
    if (isAsterisk && rawEnd !== undefined) {
      throw new Error(`cron ${range.name} range cannot start with *: ${JSON.stringify(item)}`);
    }
    if (rawStep !== undefined && rawEnd === undefined && !isAsterisk) {
      throw new Error(`cron ${range.name} step requires a range or *: ${JSON.stringify(item)}`);
    }
    const step = rawStep === undefined ? 1 : parseCronStep(rawStep, range);
    const start = isAsterisk ? range.min : parseCronValue(rawStart!, range);
    const end = isAsterisk
      ? range.max
      : rawEnd === undefined
        ? start
        : parseCronValue(rawEnd!, range);
    if (start > end) {
      throw new Error(`cron ${range.name} range start exceeds its end: ${JSON.stringify(item)}`);
    }
    for (let value = start; value <= end; value += step) {
      allowed.add(range.name === "weekday" && value === 7 ? 0 : value);
    }
  }
  return allowed;
}

export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields: ${JSON.stringify(expression)}`);
  }
  const [minuteField, hourField, dayField, monthField, weekdayField] = CRON_FIELD_RANGES;
  return {
    minute: parseCronField(fields[0]!, minuteField!),
    hour: parseCronField(fields[1]!, hourField!),
    day: parseCronField(fields[2]!, dayField!),
    month: parseCronField(fields[3]!, monthField!),
    weekday: parseCronField(fields[4]!, weekdayField!),
  };
}

export function cronMatches(schedule: CronSchedule, now: Date): boolean {
  return (
    schedule.minute.has(now.getUTCMinutes()) &&
    schedule.hour.has(now.getUTCHours()) &&
    schedule.day.has(now.getUTCDate()) &&
    schedule.month.has(now.getUTCMonth() + 1) &&
    schedule.weekday.has(now.getUTCDay())
  );
}
