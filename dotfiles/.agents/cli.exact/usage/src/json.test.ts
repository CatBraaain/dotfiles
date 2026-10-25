import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { toJsonProviderState } from "./json";
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

function project(report: UsageReport) {
  const state = toJsonProviderState(ready(report));
  assert.equal(state.status, "ready");
  if (state.status !== "ready") assert.fail("Expected ready state");
  return state.report;
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

function bucket(id: string, windowMinutes?: number): UsageBucket {
  return {
    id,
    label: id,
    unit: "percent",
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
  };
}

describe("JSON period projection", () => {
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
    const json = project(report);
    assert.deepEqual(json.long, [report.buckets[0]]);
    assert.deepEqual(json.short, [report.buckets[1]]);
    assert.equal(Object.hasOwn(json, "buckets"), false);
  });

  it("keeps Command Code monthly and weekly while excluding five-hour", () => {
    const report = normalizeCommandCodeUsagePayload(
      {
        account: { user: { userName: "fixture" } },
        credits: {
          credits: { monthlyCredits: 10 },
          windowLimits: {
            fiveHour: { used: 1, cap: 10 },
            weekly: { used: 2, cap: 100 },
          },
        },
        usage: { totalCost: 2 },
      },
      1000,
    );
    const json = project(report);
    assert.deepEqual(
      json.long.map((row) => row.id),
      ["monthly"],
    );
    assert.deepEqual(
      json.short.map((row) => row.id),
      ["weekly"],
    );
    assert.equal(Object.hasOwn(json.long[0]!, "windowMinutes"), false);
  });

  for (const windowMinutes of [0, -1, Infinity, NaN]) {
    it("omits an explicitly invalid monthly duration: " + String(windowMinutes), () => {
      const monthly = { ...bucket("monthly", windowMinutes), period: "billing-period" };
      const weekly = bucket("weekly", 10080);
      const json = project(fixture([monthly, weekly], "command-code"));
      assert.deepEqual(json.long, [weekly]);
      assert.deepEqual(json.short, []);
    });
  }

  it("keeps Z.AI plan windows and metrics while excluding monthly MCP", () => {
    const report = normalizeZaiQuotaPayload(
      "zai",
      "Z.AI",
      {
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 20 },
            { type: "TOKENS_LIMIT", unit: 6, percentage: 40 },
            {
              type: "TIME_LIMIT",
              currentValue: 2,
              usage: 100,
              usageDetails: [{ modelCode: "search", usage: 2 }],
            },
          ],
        },
      },
      1000,
    );
    const json = project(report);
    assert.deepEqual(
      json.long.map((row) => row.id),
      ["weekly"],
    );
    assert.deepEqual(
      json.short.map((row) => row.id),
      ["five-hour"],
    );
    assert.deepEqual(json.metrics, report.metrics);
  });

  it("selects the two longest distinct durations and keeps ties in original order", () => {
    const buckets = [
      bucket("small", 1),
      bucket("long-a", 100),
      bucket("short-a", 50),
      bucket("long-b", 100),
      bucket("middle", 20),
      bucket("short-b", 50),
    ];
    const json = project(fixture(buckets));
    assert.deepEqual(json.long, [buckets[1], buckets[3]]);
    assert.deepEqual(json.short, [buckets[2], buckets[5]]);
  });

  for (const buckets of [[], [bucket("single", 300), bucket("same", 300)]]) {
    it("returns empty short for " + buckets.length + " known buckets", () => {
      const json = project(fixture(buckets));
      assert.deepEqual(json.long, buckets);
      assert.deepEqual(json.short, []);
    });
  }

  it("omits unknown and nonpositive or nonfinite durations without guessing from IDs or resets", () => {
    const buckets = [
      bucket("primary"),
      bucket("weekly"),
      bucket("zero", 0),
      bucket("negative", -1),
      bucket("infinite", Infinity),
      bucket("nan", NaN),
      { ...bucket("secondary"), resetsAt: 9999999 },
    ];
    const json = project(fixture(buckets));
    assert.deepEqual(json.long, []);
    assert.deepEqual(json.short, []);
  });

  for (const [providerId, id] of [
    ["command-code", "five-hour"],
    ["zai", "mcp-monthly"],
  ]) {
    it(
      "excludes " + providerId + " " + id + " before ranking even with an explicit duration",
      () => {
        const json = project(fixture([bucket(id!, 999999), bucket("plan", 300)], providerId));
        assert.deepEqual(
          json.long.map((row) => row.id),
          ["plan"],
        );
        assert.deepEqual(json.short, []);
      },
    );
  }

  it("does not mutate input state, buckets, or remaining report fields", () => {
    const state = ready(fixture([bucket("short", 5), bucket("long", 10)]));
    const before = structuredClone(state);
    const json = toJsonProviderState(state);
    assert.deepEqual(state, before);
    assert.equal(json.status, "ready");
    if (json.status !== "ready") assert.fail("Expected ready state");
    const { buckets: _buckets, ...originalFields } = state.report;
    const { long: _long, short: _short, ...jsonFields } = json.report;
    assert.deepEqual(jsonFields, originalFields);
    assert.notEqual(json.report, state.report);
  });

  for (const status of ["auth-unavailable", "query-failed", "unsupported"] as const) {
    it("preserves " + status + " state unchanged", () => {
      const state: ProviderUsageState = {
        providerId: "zai",
        providerName: "Z.AI",
        displayState: "configured",
        status,
        message: "Fixture failure",
      };
      assert.strictEqual(toJsonProviderState(state), state);
    });
  }
});
