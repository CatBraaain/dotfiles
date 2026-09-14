import { describe, it } from "bun:test";
import assert from "node:assert/strict";
// Describe order mirrors SPEC.md: row composition (dot / title / time), then list content.
import {
  dotState,
  ensureCurrentBlank,
  rowTitle,
  timeLabel,
  visibleRows,
  type RowListSource,
  type RowSummary,
} from "./rows";

function row(overrides: Partial<RowSummary> & { id: string }): RowSummary {
  return {
    title: "",
    displayTitle: `display-${overrides.id}`,
    blank: false,
    running: false,
    completed: false,
    updatedAt: 0,
    ...overrides,
  };
}

function list(rows: RowSummary[], current?: string): Pick<RowListSource, "ids" | "byId" | "current"> {
  return {
    ids: rows.map((r) => r.id),
    byId: Object.fromEntries(rows.map((r) => [r.id, r])),
    current,
  };
}

describe("dotState", () => {
  it("ranks a pending interaction above live activity", () => {
    const pending = dotState(row({ id: "a", running: true, completed: true }), true);
    assert.equal(pending, "warning");
  });

  it("ranks running above completion", () => {
    assert.equal(dotState(row({ id: "a", running: true, completed: true }), false), "ongoing");
  });

  it("shows completion as done", () => {
    assert.equal(dotState(row({ id: "a", completed: true }), false), "done");
  });

  it("shows an idle session as idle", () => {
    assert.equal(dotState(row({ id: "a" }), false), "idle");
  });
});

describe("rowTitle", () => {
  it("uses the localized New Session label for blank rows", () => {
    assert.equal(rowTitle(row({ id: "b", blank: true }), "New Session"), "New Session");
  });

  it("prefers the durable title", () => {
    assert.equal(rowTitle(row({ id: "a", title: "fix bug" }), "New Session"), "fix bug");
  });

  it("falls back to the display title when no title is projected", () => {
    assert.equal(rowTitle(row({ id: "a", title: "" }), "New Session"), "display-a");
  });
});

describe("timeLabel", () => {
  const en: Record<string, string> = {
    "time.now": "now",
    "time.minutes": "{n}min",
    "time.hours": "{n}h",
  };
  const t = (key: string, params?: Record<string, unknown>) =>
    (en[key] ?? key).replace("{n}", String(params?.n ?? ""));

  it("renders the now bucket bare", () => {
    assert.equal(timeLabel({ unit: "now", n: 0 }, t), "now");
  });

  it("renders counted buckets through the dictionary", () => {
    assert.equal(timeLabel({ unit: "minutes", n: 5 }, t), "5min");
    assert.equal(timeLabel({ unit: "hours", n: 3 }, t), "3h");
  });
});

describe("visibleRows", () => {
  it("keeps host order for ordinary rows", () => {
    const rows = visibleRows(list([row({ id: "a" }), row({ id: "b" })], "a"), []);
    assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  });

  it("drops subagent-origin rows", () => {
    const rows = visibleRows(list([row({ id: "a" }), row({ id: "s", origin: "subagent" })], "a"), []);
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });

  it("drops archived rows", () => {
    const rows = visibleRows(list([row({ id: "a" }), row({ id: "gone" })], "a"), ["gone"]);
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });

  it("drops blank rows that are not the current session", () => {
    const rows = visibleRows(
      list([row({ id: "a" }), row({ id: "other-blank", blank: true })], "a"),
      [],
    );
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });

  it("keeps the current blank row", () => {
    const rows = visibleRows(
      list([row({ id: "current-blank", blank: true }), row({ id: "a" })], "current-blank"),
      [],
    );
    assert.deepEqual(rows.map((r) => r.id), ["current-blank", "a"]);
  });

  it("skips ids absent from byId", () => {
    const source = { ids: ["a", "missing"], byId: { a: row({ id: "a" }) }, current: undefined };
    const rows = visibleRows(source, []);
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });
});

describe("ensureCurrentBlank", () => {
  it("prepends the current blank session when the host list omits it", () => {
    const blank = row({ id: "blank", blank: true });
    const rows = ensureCurrentBlank([row({ id: "a" })], { current: "blank", byId: { blank } });
    assert.deepEqual(rows.map((r) => r.id), ["blank", "a"]);
  });

  it("keeps a single instance when the current blank row is already listed", () => {
    const blank = row({ id: "blank", blank: true });
    const rows = ensureCurrentBlank([blank, row({ id: "a" })], { current: "blank", byId: { blank } });
    assert.deepEqual(rows.map((r) => r.id), ["blank", "a"]);
  });

  it("does nothing without a current session", () => {
    const rows = ensureCurrentBlank([row({ id: "a" })], { current: undefined, byId: {} });
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });

  it("does nothing when the current session is not blank", () => {
    const ordinary = row({ id: "a" });
    const rows = ensureCurrentBlank([], { current: "a", byId: { a: ordinary } });
    assert.deepEqual(rows, []);
  });
});
