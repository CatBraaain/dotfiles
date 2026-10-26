import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { summarizeProviderUsage, summarizeProviderUsageJson } from "./summary";
import { renderProviderState } from "./format";
import { normalizeCodexBackendPayload } from "./providers/codex";
import { normalizeCommandCodeUsagePayload } from "./providers/command-code";
import { normalizeZaiQuotaPayload } from "./providers/zai";
import type { ProviderUsageState, UsageBucket, UsageReport } from "./types";

function ready(report: UsageReport): Extract<ProviderUsageState, { status: "ready" }> {
  return {
    providerId: report.providerId,
    providerName: report.providerName,
    displayState: "configured",
    status: "ready",
    report,
  };
}

function fixture(buckets: UsageBucket[], providerId = "openai-codex"): UsageReport {
  return {
    providerId,
    providerName: "Fixture",
    capturedAt: 1000,
    source: "fixture",
    semantics: { kind: "consumer-subscription", label: "Fixture limits" },
    buckets,
    metrics: [{ id: "credits", label: "Credits", value: 12 }],
    notes: ["Fixture note"],
    accountLabel: "Fixture account",
  };
}

function bucket(id: string, windowMinutes?: number, remaining = 80): UsageBucket {
  return { id, label: id, unit: "percent", remaining, windowMinutes };
}

describe("JSON local reset date times", () => {
  const cases = [
    { zone: "UTC", short: "2026-11-01T05:30:54+00:00", long: "2026-11-01T06:30:54+00:00" },
    { zone: "Asia/Tokyo", short: "2026-11-01T14:30:54+09:00", long: "2026-11-01T15:30:54+09:00" },
    {
      zone: "America/New_York",
      short: "2026-11-01T01:30:54-04:00",
      long: "2026-11-01T01:30:54-05:00",
    },
  ];
  for (const fixtureCase of cases) {
    it("uses the offset at each reset instant in " + fixtureCase.zone, () => {
      const previousZone = process.env.TZ;
      try {
        process.env.TZ = fixtureCase.zone;
        const state = ready(
          fixture([
            { ...bucket("short", 300), resetsAt: Date.parse("2026-11-01T05:30:54.999Z") / 1000 },
            {
              ...bucket("long", 10080, 70),
              resetsAt: Date.parse("2026-11-01T06:30:54.001Z") / 1000,
            },
          ]),
        );
        assert.deepEqual(summarizeProviderUsageJson(state), {
          provider: "openai-codex",
          short: 80,
          shortResetsAt: fixtureCase.short,
          long: 70,
          longResetsAt: fixtureCase.long,
        });
      } finally {
        if (previousZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousZone;
      }
    });
  }

  for (const resetsAt of [undefined, NaN, Infinity, -Infinity, 1e20]) {
    it("keeps unavailable or unrepresentable reset times null: " + resetsAt, () => {
      const state = ready(
        fixture([
          { ...bucket("short", 300), resetsAt },
          { ...bucket("long", 10080, 70), resetsAt },
        ]),
      );
      assert.deepEqual(summarizeProviderUsageJson(state), {
        provider: "openai-codex",
        short: 80,
        shortResetsAt: null,
        long: 70,
        longResetsAt: null,
      });
    });
  }

  it("preserves epoch zero for providers other than Command Code", () => {
    const previousZone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      for (const provider of ["openai-codex", "zai"]) {
        const state = ready(fixture([{ ...bucket("long", 300), resetsAt: 0 }], provider));
        assert.equal(summarizeProviderUsageJson(state).longResetsAt, "1970-01-01T00:00:00+00:00");
      }
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });

  for (const resetAt of [0, "0", "00", " 0 ", -0]) {
    it(
      "renders unknown Command Code resets without losing remaining rates: " +
        JSON.stringify(resetAt),
      () => {
        const report = normalizeCommandCodeUsagePayload(
          {
            account: { user: { userName: "fixture" } },
            credits: {
              windowLimits: {
                fiveHour: { used: 0, cap: 3, resetAt },
                weekly: { used: 0, cap: 6, resetAt },
              },
            },
          },
          1000,
        );
        const state = ready(report);
        assert.deepEqual(summarizeProviderUsageJson(state), {
          provider: "command-code",
          short: 100,
          shortResetsAt: null,
          long: 100,
          longResetsAt: null,
        });
        assert.equal(
          renderProviderState(state),
          "Command   100%              —   100%             —",
        );
      },
    );
  }
});

describe("JSON remaining summary", () => {
  it("returns exactly five fields with the canonical provider ID and numeric percentages", () => {
    const state = ready(fixture([bucket("short", 300), bucket("long", 10_080, 70)]));
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: 80,
      shortResetsAt: null,
      long: 70,
      longResetsAt: null,
    });
  });

  it("ranks actual Codex durations rather than primary positions or reset proximity", () => {
    const report = normalizeCodexBackendPayload(
      {
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1001 },
          secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 999999 },
        },
      },
      1000,
    );
    assert.deepEqual(summarizeProviderUsage(ready(report)), {
      provider: "openai-codex",
      short: 80,
      shortResetsAt: 999999,
      long: 90,
      longResetsAt: 1001,
    });
  });

  it("includes Command Code rolling windows and excludes monthly credits", () => {
    const report = normalizeCommandCodeUsagePayload(
      {
        account: { user: { userName: "fixture" } },
        credits: {
          credits: { monthlyCredits: 10 },
          windowLimits: { fiveHour: { used: 1, cap: 10 }, weekly: { used: 2, cap: 100 } },
        },
        usage: { totalCost: 2 },
      },
      1000,
    );
    assert.deepEqual(summarizeProviderUsage(ready(report)), {
      provider: "command-code",
      short: 90,
      shortResetsAt: null,
      long: 98,
      longResetsAt: null,
    });
  });

  it("converts Z.AI count quotas to percentages and excludes monthly MCP", () => {
    const report = normalizeZaiQuotaPayload(
      "zai",
      "Z.AI",
      {
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 20 },
            { type: "TOKENS_LIMIT", unit: 6, currentValue: 2, usage: 5 },
            { type: "TIME_LIMIT", currentValue: 2, usage: 100 },
          ],
        },
      },
      1000,
    );
    assert.deepEqual(summarizeProviderUsage(ready(report)), {
      provider: "zai",
      short: 80,
      shortResetsAt: null,
      long: 60,
      longResetsAt: null,
    });
  });

  it("chooses short by remaining rate across all windows other than long", () => {
    const state = ready(
      fixture([
        { ...bucket("tiny", 1, 90), resetsAt: 100 },
        { ...bucket("long", 100, 70), resetsAt: 200 },
        { ...bucket("middle", 50, 80), resetsAt: 300 },
      ]),
    );
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: 90,
      shortResetsAt: 100,
      long: 70,
      longResetsAt: 200,
    });
  });

  it("chooses the first longest window and allows another equally long window as short", () => {
    const state = ready(
      fixture([
        { ...bucket("first", 100, 50), resetsAt: 10 },
        { ...bucket("second", 100, 80), resetsAt: 20 },
        { ...bucket("third", 50, 80), resetsAt: 30 },
      ]),
    );
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: 80,
      shortResetsAt: 20,
      long: 50,
      longResetsAt: 10,
    });
  });

  it("returns null for both fields with no eligible windows", () => {
    assert.deepEqual(summarizeProviderUsage(ready(fixture([]))), {
      provider: "openai-codex",
      short: null,
      shortResetsAt: null,
      long: null,
      longResetsAt: null,
    });
  });

  it("returns null short with only one window and preserves zero remaining", () => {
    assert.deepEqual(summarizeProviderUsage(ready(fixture([bucket("single", 300, 0)]))), {
      provider: "openai-codex",
      short: null,
      shortResetsAt: null,
      long: 0,
      longResetsAt: null,
    });
  });

  it("does not guess unknown durations from IDs or resets", () => {
    const state = ready(
      fixture([
        bucket("weekly"),
        bucket("zero", 0),
        bucket("negative", -1),
        bucket("infinite", Infinity),
        bucket("nan", NaN),
        { ...bucket("secondary"), resetsAt: 9999999 },
      ]),
    );
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: null,
      shortResetsAt: null,
      long: null,
      longResetsAt: null,
    });
  });

  for (const [providerId, id] of [
    ["command-code", "monthly"],
    ["zai", "mcp-monthly"],
  ]) {
    it("excludes " + providerId + " " + id + " even with an explicit duration", () => {
      const state = ready(fixture([bucket(id!, 999999), bucket("plan", 300, 70)], providerId));
      assert.deepEqual(summarizeProviderUsage(state), {
        provider: providerId,
        short: null,
        shortResetsAt: null,
        long: 70,
        longResetsAt: null,
      });
    });
  }

  it("uses null for unavailable percentages rather than substituting shorter long windows", () => {
    const state = ready(
      fixture([
        { id: "long", label: "Long", unit: "count", windowMinutes: 100, resetsAt: 1234 },
        bucket("short", 50, 80),
        { ...bucket("unknown", 10), remaining: NaN },
      ]),
    );
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: 80,
      shortResetsAt: null,
      long: null,
      longResetsAt: 1234,
    });
  });

  for (const resetsAt of [undefined, NaN, Infinity, -Infinity]) {
    it(`returns null reset times without losing percentages for ${resetsAt}`, () => {
      const state = ready(
        fixture([
          { ...bucket("short", 5), resetsAt },
          { ...bucket("long", 10, 70), resetsAt },
        ]),
      );
      assert.deepEqual(summarizeProviderUsage(state), {
        provider: "openai-codex",
        short: 80,
        shortResetsAt: null,
        long: 70,
        longResetsAt: null,
      });
    });
  }

  it("preserves epoch zero and fractional UNIX seconds without percentage coupling", () => {
    const state = ready(
      fixture([
        { ...bucket("short", 5), resetsAt: 0 },
        { ...bucket("long", 10, 0), resetsAt: 1234.5 },
      ]),
    );
    assert.deepEqual(summarizeProviderUsage(state), {
      provider: "openai-codex",
      short: 80,
      shortResetsAt: 0,
      long: 0,
      longResetsAt: 1234.5,
    });
  });

  it("does not mutate the original report or its buckets", () => {
    const state = ready(fixture([bucket("short", 5), bucket("long", 10)]));
    const before = structuredClone(state);
    summarizeProviderUsage(state);
    assert.deepEqual(state, before);
  });

  for (const status of ["auth-unavailable", "query-failed", "unsupported"] as const) {
    it("returns provider and null percentages and reset times for " + status, () => {
      const state: ProviderUsageState = {
        providerId: "zai",
        providerName: "Z.AI",
        displayState: "configured",
        status,
        message: "Fixture failure with 50% and secret",
      };
      assert.deepEqual(summarizeProviderUsage(state), {
        provider: "zai",
        short: null,
        shortResetsAt: null,
        long: null,
        longResetsAt: null,
      });
    });
  }

  const parityCases: Array<{
    name: string;
    buckets: UsageBucket[];
    short: number | null;
    long: number | null;
  }> = [
    {
      name: "fractional percent",
      buckets: [bucket("day", 1440, 66.5), bucket("hour", 60, 79.6)],
      short: 80,
      long: 67,
    },
    {
      name: "count ratio",
      buckets: [{ id: "day", label: "Day", unit: "count", used: 1, limit: 3, windowMinutes: 1440 }],
      short: null,
      long: 67,
    },
    {
      name: "unavailable",
      buckets: [
        { id: "day", label: "Day", unit: "usd", remaining: 1, limit: 0, windowMinutes: 1440 },
      ],
      short: null,
      long: null,
    },
    {
      name: "clamped values",
      buckets: [bucket("day", 1440, -10), bucket("hour", 60, 110)],
      short: 100,
      long: 0,
    },
  ];
  for (const testCase of parityCases) {
    it("matches table values and rounding for " + testCase.name, () => {
      const state = ready(fixture(testCase.buckets));
      const json = summarizeProviderUsage(state);
      assert.deepEqual(json, {
        provider: "openai-codex",
        short: testCase.short,
        shortResetsAt: null,
        long: testCase.long,
        longResetsAt: null,
      });
      const tableCells = renderProviderState(state).trim().split(/\s+/u).slice(1);
      const expectedCells = [json.short, json.long].map((remaining) =>
        remaining === null ? "—" : `${remaining}%`,
      );
      assert.deepEqual(tableCells, [expectedCells[0], "—", expectedCells[1], "—"]);
    });
  }
});
