import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  DOW,
  MINUTE,
  MONTH,
  dowNames,
  fieldFirst,
  fieldSpan,
  fieldValues,
  isEvery,
  isRange,
  isStar,
  isStep,
  monthNames,
  parseCron,
  parseField,
  type Field,
} from "./cron.ts";

const minute = (text: string) => parseField(text, "minute", MINUTE, [], false);
const minuteErr = (text: string) => () => parseField(text, "minute", MINUTE, [], false);
const dow = (text: string) => parseField(text, "weekday", DOW, dowNames(), true);
const dowErr = (text: string) => () => parseField(text, "weekday", DOW, dowNames(), true);
const month = (text: string) => parseField(text, "month", MONTH, monthNames(), false);
const monthErr = (text: string) => () => parseField(text, "month", MONTH, monthNames(), false);

describe("cron field parsing", () => {
  it("star and question normalize to star", () => {
    assert.deepEqual(minute("*"), { kind: "star", incr: 1 });
    assert.deepEqual(dow("?"), { kind: "star", incr: 1 });
  });

  it("full range normalizes to star", () => {
    assert.deepEqual(minute("0-59"), { kind: "star", incr: 1 });
    assert.deepEqual(dow("0-6"), { kind: "star", incr: 1 });
    assert.deepEqual(minute("0-59/5"), { kind: "star", incr: 5 });
  });

  it("single value and degenerate range become list", () => {
    assert.deepEqual(minute("5"), { kind: "list", values: [5] });
    assert.deepEqual(minute("5-5"), { kind: "list", values: [5] });
  });

  it("n slash n extends to field max", () => {
    assert.deepEqual(minute("30/10"), { kind: "range", start: 30, end: 59, incr: 10 });
  });

  it("list expands ranges and sorts", () => {
    assert.deepEqual(minute("5,1-3,9"), { kind: "list", values: [1, 2, 3, 5, 9] });
  });

  it("names are case insensitive and mixed with numbers", () => {
    assert.deepEqual(dow("sun,1,Fri"), { kind: "list", values: [0, 1, 5] });
    assert.deepEqual(month("Jan-dec"), { kind: "star", incr: 1 });
  });

  it("rejects question in non day fields", () => {
    assert.throws(() => parseField("?", "minute", MINUTE, [], false));
    assert.throws(() => parseField("?,5", "weekday", DOW, dowNames(), true));
  });

  it("rejects month and dow steps", () => {
    assert.throws(monthErr("*/5"), /not supported/);
    assert.throws(dowErr("MON/3"), /not supported/);
    assert.throws(monthErr("1-12/2"), /not supported/);
  });

  it("rejects dow seven", () => {
    assert.throws(dowErr("7"), /0-6/);
  });

  it("rejects list step mix", () => {
    assert.throws(() => parseField("1,3/2", "minute", MINUTE, [], false), /cannot be mixed/);
  });

  it("rejects reversed and out of range", () => {
    assert.throws(minuteErr("5-1"), /reversed/);
    assert.throws(minuteErr("60"), /0-59/);
    assert.throws(minuteErr("*/0"), />= 1/);
  });

  it("rejects quartz extensions", () => {
    assert.throws(minuteErr("L"), /invalid/);
    assert.throws(minuteErr("15W"), /invalid/);
    assert.throws(() => parseCron("@daily"));
    assert.throws(() => parseCron("* * * * * *"));
  });

  it("parses five field expression", () => {
    const spec = parseCron("00 09 * * *");
    assert.deepEqual(spec.minute, { kind: "list", values: [0] });
    assert.deepEqual(spec.hour, { kind: "list", values: [9] });
    assert.deepEqual(spec.day, { kind: "star", incr: 1 });
    assert.deepEqual(spec.dow, { kind: "star", incr: 1 });
  });

  it("parses sunday zero and named weekdays", () => {
    parseCron("0 12 * * 0");
    parseCron("0 12 * * sun");
    parseCron("*/15 9-17 * * MON-FRI");
  });

  it("rejects steps above field maximum", () => {
    assert.throws(minuteErr("*/60"), /step must be <= 59/);
    assert.throws(() => parseCron("* */24 * * *"));
  });

  it("field helpers", () => {
    const star: Field = { kind: "star", incr: 1 };
    assert.ok(isStar(star) && isEvery(star));
    const step: Field = { kind: "range", start: 3, end: 33, incr: 6 };
    assert.ok(isStep(step) && !isRange(step));
    assert.deepEqual(fieldValues(step, 0, 59), [3, 9, 15, 21, 27, 33]);
    assert.equal(fieldSpan(step, 0, 59), 31);
    assert.equal(fieldSpan(star, 0, 23), 24);
    assert.equal(fieldFirst(star, 0), 0);
  });
});
