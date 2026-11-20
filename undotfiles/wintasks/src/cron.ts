// Cron expression parsing for trigger decomposition.
// The spec's trigger decomposition table needs the structure of each field
// (star / range / step / list), so syntax is parsed here and expanded directly
// into Task Scheduler trigger definitions.

export type Field =
  | { kind: "star"; incr: number }
  | { kind: "range"; start: number; end: number; incr: number }
  | { kind: "list"; values: number[] };

type FieldKind = "star" | "every" | "range" | "step" | "list";

export function fieldKind(field: Field): FieldKind {
  switch (field.kind) {
    case "star":
      return field.incr === 1 ? "every" : "star";
    case "range":
      return field.incr === 1 ? "range" : "step";
    case "list":
      return "list";
  }
}

export function isStar(field: Field): boolean {
  const kind = fieldKind(field);
  return kind === "star" || kind === "every";
}

export function isEvery(field: Field): boolean {
  return fieldKind(field) === "every";
}

export function isRange(field: Field): boolean {
  return fieldKind(field) === "range";
}

export function isStep(field: Field): boolean {
  return fieldKind(field) === "step";
}

export function isList(field: Field): boolean {
  return fieldKind(field) === "list";
}

export function fieldValues(field: Field, min: number, max: number): number[] {
  switch (field.kind) {
    case "star": {
      const values: number[] = [];
      for (let v = min; v <= max; v += field.incr) values.push(v);
      return values;
    }
    case "range": {
      const values: number[] = [];
      for (let v = field.start; v <= field.end; v += field.incr) values.push(v);
      return values;
    }
    case "list":
      return [...field.values];
  }
}

export function fieldFirst(field: Field, min: number): number {
  switch (field.kind) {
    case "star":
      return min;
    case "range":
      return field.start;
    case "list":
      return field.values[0]!;
  }
}

export function fieldSpan(field: Field, min: number, max: number): number {
  switch (field.kind) {
    case "star":
      return max - min + 1;
    case "range":
      return field.end - field.start + 1;
    case "list":
      return field.values[field.values.length - 1]! - field.values[0]! + 1;
  }
}

export function fieldIncr(field: Field): number {
  switch (field.kind) {
    case "star":
    case "range":
      return field.incr;
    case "list":
      return 1;
  }
}

export interface CronSpec {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  dow: Field;
}

export const MINUTE = [0, 59] as const;
export const HOUR = [0, 23] as const;
export const DAY = [1, 31] as const;
export const MONTH = [1, 12] as const;
export const DOW = [0, 6] as const;

export function monthNames(): Array<[string, number]> {
  return ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].map(
    (name, index) => [name, index + 1] as [string, number],
  );
}

export function dowNames(): Array<[string, number]> {
  return ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map(
    (name, index) => [name, index] as [string, number],
  );
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.split(/\s+/).filter((field) => field.length > 0);
  if (fields.length !== 5) {
    throw new Error(
      `invalid cron expression \`${expr}\`: expected 5 fields (minute hour day month weekday), got ${fields.length}`,
    );
  }
  return {
    minute: parseField(fields[0]!, "minute", MINUTE, [], false),
    hour: parseField(fields[1]!, "hour", HOUR, [], false),
    day: parseField(fields[2]!, "day", DAY, [], true),
    month: parseField(fields[3]!, "month", MONTH, monthNames(), false),
    dow: parseField(fields[4]!, "weekday", DOW, dowNames(), true),
  };
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const c of text) {
    if (c === ch) count++;
  }
  return count;
}

function parseUint(text: string): number | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseField(
  text: string,
  name: string,
  range: readonly [number, number],
  names: Array<[string, number]>,
  allowsQuestion: boolean,
): Field {
  const [min, max] = range;
  if (text === "?") {
    if (!allowsQuestion) {
      throw new Error(`\`?\` is not allowed in the ${name} field`);
    }
    return { kind: "star", incr: 1 };
  }

  const commaCount = countChar(text, ",");
  const slashCount = countChar(text, "/");
  if (slashCount > 1 || (slashCount === 1 && commaCount > 0)) {
    throw new Error(`invalid ${name} field \`${text}\`: steps cannot be mixed with lists`);
  }

  if (commaCount > 0) {
    const values: number[] = [];
    for (const item of text.split(",")) {
      const [lo, hi] = parseValueOrRange(item, name, min, max, names);
      for (let v = lo; v <= hi; v++) values.push(v);
    }
    values.sort((a, b) => a - b);
    const unique = values.filter((v, index) => index === 0 || v !== values[index - 1]);
    return { kind: "list", values: unique };
  }

  let body = text;
  let incr = 1;
  let hasStep = false;
  const slashIndex = text.indexOf("/");
  if (slashIndex !== -1) {
    const step = parseUint(text.slice(slashIndex + 1));
    if (step === null) {
      throw new Error(`invalid ${name} field \`${text}\`: step must be a number`);
    }
    if (step === 0) {
      throw new Error(`invalid ${name} field \`${text}\`: step must be >= 1`);
    }
    if (step > max) {
      throw new Error(`invalid ${name} field \`${text}\`: step must be <= ${max}`);
    }
    body = text.slice(0, slashIndex);
    incr = step;
    hasStep = true;
  }

  if (incr > 1 && (name === "month" || name === "weekday")) {
    throw new Error(
      `invalid ${name} field \`${text}\`: steps are not supported for month and weekday`,
    );
  }

  if (body === "*") {
    return { kind: "star", incr };
  }

  const [start, end] = parseValueOrRange(body, name, min, max, names);
  if (!body.includes("-")) {
    if (hasStep) {
      return { kind: "range", start, end: max, incr };
    }
    return { kind: "list", values: [start] };
  }
  if (start === end) {
    return { kind: "list", values: [start] };
  }
  if (start === min && end === max) {
    return { kind: "star", incr };
  }
  return { kind: "range", start, end, incr };
}

function parseValueOrRange(
  text: string,
  name: string,
  min: number,
  max: number,
  names: Array<[string, number]>,
): [number, number] {
  const parseOne = (token: string): number => {
    const upper = token.toUpperCase();
    const named = names.find(([candidate]) => candidate === upper);
    if (named !== undefined) return named[1];
    const value = parseUint(token);
    if (value === null) {
      throw new Error(`invalid ${name} field value \`${token}\``);
    }
    if (value < min || value > max) {
      throw new Error(`invalid ${name} field value \`${token}\`: must be ${min}-${max}`);
    }
    return value;
  };

  const dashIndex = text.indexOf("-");
  if (dashIndex !== -1) {
    const lo = parseOne(text.slice(0, dashIndex));
    const hi = parseOne(text.slice(dashIndex + 1));
    if (lo > hi) {
      throw new Error(`invalid ${name} field \`${text}\`: range is reversed`);
    }
    return [lo, hi];
  }
  const value = parseOne(text);
  return [value, value];
}
