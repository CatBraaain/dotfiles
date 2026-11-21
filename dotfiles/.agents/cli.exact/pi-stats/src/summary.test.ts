import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { SessionRecord, UsageEventRecord } from "./db";
import {
  buildSummary,
  formatCost,
  formatPercent,
  formatTokens,
  localDateKey,
  startOfLocalDay,
  projectOfSession,
  type SummarySource,
} from "./summary";

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0);

describe("timezone helpers", () => {
  it("startOfLocalDay returns UTC midnight in UTC", () => {
    assert.equal(startOfLocalDay(Date.UTC(2026, 0, 15, 12, 30), "UTC"), Date.UTC(2026, 0, 15));
  });

  it("startOfLocalDay returns JST midnight for a JST instant", () => {
    assert.equal(startOfLocalDay(Date.UTC(2026, 0, 15, 12, 30), "Asia/Tokyo"), Date.UTC(2026, 0, 14, 15));
  });

  it("localDateKey shifts the date by the timezone", () => {
    assert.equal(localDateKey(Date.UTC(2026, 0, 14, 15, 30), "Asia/Tokyo"), "2026-01-15");
    assert.equal(localDateKey(Date.UTC(2026, 0, 14, 15, 30), "UTC"), "2026-01-14");
  });
});

describe("buildSummary", () => {
  it("aggregates overview rows with today boundary and rolling windows", () => {
    const events = [
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 14, 23, 0), 100, 100, 10),
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 15, 1, 0), 0, 50, 5),
      makeEvent("/s/--p2--/b.jsonl", Date.UTC(2026, 0, 8, 11, 0), 100, 0, 20),
    ];
    const sessions = [
      makeSession("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 15, 0, 30)),
      makeSession("/s/--p2--/b.jsonl", Date.UTC(2026, 0, 10, 9, 0)),
    ];
    const data = buildSummary(fakeSource(events, sessions), makeOptions({ timeZone: "UTC" }));
    assert.deepEqual(
      data.overview.map((row) => row.label),
      ["today", "7 days", "30 days", "all"],
    );
    const byLabel = new Map(data.overview.map((row) => [row.label, row]));
    const today = byLabel.get("today");
    assert.equal(today?.totals.requests, 1);
    assert.equal(today?.sessions, 1);
    assert.equal(today?.hitRate, 1);
    const sevenDays = byLabel.get("7 days");
    assert.equal(sevenDays?.totals.requests, 2);
    assert.equal(sevenDays?.sessions, 2);
    const thirtyDays = byLabel.get("30 days");
    assert.equal(thirtyDays?.totals.requests, 3);
    assert.equal(thirtyDays?.sessions, 2);
    const all = byLabel.get("all");
    assert.equal(all?.totals.requests, 3);
    assert.equal(all?.totals.cost, closeTo(0.035));
  });

  it("applies explicit since/until filters in local time", () => {
    const events = [
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 14, 10, 0), 10, 0, 1),
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 15, 1, 0), 20, 0, 2),
    ];
    const data = buildSummary(fakeSource(events, []), makeOptions({ timeZone: "Asia/Tokyo", since: "2026-01-15" }));
    assert.equal(data.eventCount, 1);
    assert.equal(data.overview[3]?.totals.input, 20);
  });

  it("aggregates per model sorted by tokens with a top limit", () => {
    const events = [
      makeEvent("/s/--p1--/a.jsonl", 1_000, 100, 0, 10, "zai", "glm"),
      makeEvent("/s/--p1--/a.jsonl", 2_000, 0, 0, 500, "anthropic", "claude"),
      makeEvent("/s/--p2--/b.jsonl", 3_000, 10, 0, 5, "zai", "glm"),
    ];
    const data = buildSummary(fakeSource(events, []), makeOptions({ topModels: 1 }));
    assert.equal(data.models.length, 1);
    assert.equal(data.models[0]?.key, "anthropic/claude");
    const full = buildSummary(fakeSource(events, []), makeOptions({ topModels: 10 }));
    assert.deepEqual(
      full.models.map((row) => row.key),
      ["anthropic/claude", "zai/glm"],
    );
  });

  it("builds daily rows for the last N days with zero-fill", () => {
    const events = [
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 14, 10, 0), 100, 0, 1),
      makeEvent("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 15, 10, 0), 200, 0, 2),
    ];
    const sessions = [makeSession("/s/--p1--/a.jsonl", Date.UTC(2026, 0, 15, 8, 0))];
    const data = buildSummary(fakeSource(events, sessions), makeOptions({ timeZone: "UTC", days: 3 }));
    assert.deepEqual(
      data.daily.map((row) => row.dateKey),
      ["2026-01-13", "2026-01-14", "2026-01-15"],
    );
    assert.equal(data.daily[0]?.totals.requests, 0);
    assert.equal(data.daily[0]?.sessions, 0);
    assert.equal(data.daily[1]?.totals.input, 100);
    assert.equal(data.daily[2]?.totals.input, 200);
    assert.equal(data.daily[2]?.sessions, 1);
  });

  it("aggregates per project by usage sessions", () => {
    const events = [
      makeEvent("/sessions/--alpha--/a.jsonl", 1_000, 100, 0, 10),
      makeEvent("/sessions/--alpha--/a.jsonl", 2_000, 100, 0, 10),
      makeEvent("/sessions/--beta--/b.jsonl", 3_000, 0, 0, 1_000),
    ];
    const data = buildSummary(fakeSource(events, []), makeOptions({ topProjects: 10 }));
    assert.deepEqual(
      data.projects.map((row) => row.key),
      ["--beta--", "--alpha--"],
    );
    assert.equal(data.projects[0]?.sessions, 1);
    assert.equal(data.projects[1]?.sessions, 1);
  });

  it("lists top sessions with their dominant model", () => {
    const events = [
      makeEvent("/s/--alpha--/a.jsonl", 1_000, 10, 0, 100, "zai", "glm"),
      makeEvent("/s/--alpha--/a.jsonl", 2_000, 10, 0, 900, "anthropic", "claude"),
      makeEvent("/s/--beta--/b.jsonl", 3_000, 10, 0, 50, "zai", "glm"),
    ];
    const sessions = [makeSession("/s/--alpha--/a.jsonl", Date.UTC(2026, 0, 10, 1, 0))];
    const data = buildSummary(fakeSource(events, sessions), makeOptions({ topSessions: 1, timeZone: "UTC" }));
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0]?.topModel, "anthropic/claude");
    assert.equal(data.sessions[0]?.totalTokens, 1_000);
    assert.equal(data.sessions[0]?.startedLabel, "2026-01-10 01:00");
  });

  it("counts (unknown) for events without provider and model", () => {
    const events = [makeEvent("/s/--alpha--/a.jsonl", 1_000, 10, 0, 100, "", "")];
    const data = buildSummary(fakeSource(events, []), makeOptions({}));
    assert.equal(data.models[0]?.key, "(unknown)");
  });
});

describe("projectOfSession", () => {
  it("extracts the project directory name", () => {
    assert.equal(projectOfSession("/home/u/.pi/agent/sessions/--proj-x--/a.jsonl"), "--proj-x--");
    assert.equal(projectOfSession("a.jsonl"), "");
  });
});

describe("formatters", () => {
  it("formats tokens compactly", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(2_345_678), "2.3M");
    assert.equal(formatTokens(1_234_567_890), "1.2B");
  });

  it("formats cost and hit rate", () => {
    assert.equal(formatCost(0.5), "$0.5000");
    assert.equal(formatPercent(0.5), "50%");
    assert.equal(formatPercent(null), "—");
  });
});

function fakeSource(events: UsageEventRecord[], sessions: SessionRecord[]): SummarySource {
  return {
    eachEvent(callback) {
      for (const event of events) callback(event);
    },
    eachSession(callback) {
      for (const session of sessions) callback(session);
    },
  };
}

interface OptionsOverrides {
  timeZone?: string;
  since?: string;
  until?: string;
  days?: number;
  topModels?: number;
  topProjects?: number;
  topSessions?: number;
}

function makeOptions(overrides: OptionsOverrides = {}) {
  return {
    nowMs: NOW_MS,
    timeZone: overrides.timeZone ?? "UTC",
    fromMs: parseLocalMidnight(overrides.since, overrides.timeZone ?? "UTC"),
    untilMs: parseLocalMidnight(overrides.until, overrides.timeZone ?? "UTC"),
    days: overrides.days ?? 14,
    topModels: overrides.topModels ?? 20,
    topProjects: overrides.topProjects ?? 20,
    topSessions: overrides.topSessions ?? 20,
    projectBySession: new Map<string, string>(),
  };
}

function parseLocalMidnight(raw: string | undefined, timeZone: string): number | null {
  if (raw === undefined) return null;
  return startOfLocalDay(Date.parse(`${raw}T00:00:00Z`), timeZone);
}

function makeEvent(
  sessionPath: string,
  tsMs: number,
  input: number,
  cacheRead: number,
  totalTokens: number,
  provider = "zai",
  model = "glm-5.3-flash",
): UsageEventRecord {
  return {
    sessionPath,
    tsMs,
    kind: "message",
    provider,
    model,
    input,
    output: 0,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
    cost: totalTokens / 1000,
  };
}

function makeSession(path: string, startedMs: number): SessionRecord {
  return {
    path,
    mtimeMs: startedMs,
    size: 1,
    project: "--proj--",
    sessionId: "id",
    cwd: "/tmp",
    startedMs,
    isSubagent: false,
  };
}

function closeTo(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
