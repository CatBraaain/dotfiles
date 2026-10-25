import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { renderProviderState, renderUsageTable } from "./format";
import type { ProviderUsageState, UsageBucket, UsageReport } from "./types";

const report: UsageReport = {
  providerId: "openai-codex",
  providerName: "OpenAI Codex",
  capturedAt: 1_700_000_000_000,
  source: "codex-pi-auth",
  semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
  accountLabel: "test-account",
  buckets: [],
  metrics: [{ id: "credits", label: "Credits", value: 12, unit: "count" }],
  notes: ["Plan: pro", "Usage may be delayed."],
};

function percentBucket(id: string, windowMinutes: number, used: number): UsageBucket {
  return { id, label: id, unit: "percent", used, remaining: 100 - used, windowMinutes };
}

function readyState(buckets: UsageBucket[], providerId = "openai-codex"): ProviderUsageState {
  return {
    providerId,
    providerName: report.providerName,
    displayState: "current",
    status: "ready",
    report: { ...report, providerId, buckets },
  };
}

describe("renderUsageTable", () => {
  it("renders only provider names and remaining percentages under one header", () => {
    const buckets = [percentBucket("session", 300, 20), percentBucket("week", 10_080, 30)];
    const states = [
      readyState(buckets),
      readyState(buckets, "command-code"),
      readyState(buckets, "zai"),
    ];
    const output = renderUsageTable(states);
    const expected = [
      "         short   long",
      "Codex      80%    70%",
      "Command    80%    70%",
      "Z.AI       80%    70%",
    ].join("\n");
    assert.equal(output, expected);
  });

  it("returns an empty string when there are no providers", () => {
    assert.equal(renderUsageTable([]), "");
  });
});

describe("renderProviderState", () => {
  it("chooses long by duration and short by lowest consumption, not second-longest duration", () => {
    const state = readyState([
      percentBucket("day", 1_440, 70),
      percentBucket("ten-days", 14_400, 25),
      percentBucket("two-hours", 120, 10),
    ]);
    assert.equal(renderProviderState(state), "Codex      90%    75%");
  });

  it("includes normal Command rolling windows and excludes monthly credits", () => {
    const state = readyState(
      [
        {
          id: "five-hour",
          label: "5h",
          used: 2,
          remaining: 8,
          limit: 10,
          unit: "usd",
          windowMinutes: 300,
        },
        {
          id: "weekly",
          label: "Week",
          used: 40,
          remaining: 60,
          limit: 100,
          unit: "usd",
          windowMinutes: 10_080,
        },
        {
          id: "monthly",
          label: "Credits",
          remaining: 1_000,
          limit: 1_000,
          unit: "usd",
          windowMinutes: 43_200,
        },
      ],
      "command-code",
    );
    assert.equal(renderProviderState(state), "Command    80%    60%");
  });

  it("converts count quotas to percentages and excludes MCP monthly allowances", () => {
    const state = readyState(
      [
        percentBucket("five-hour", 300, 10),
        {
          id: "weekly",
          label: "Week",
          used: 2,
          remaining: 8,
          limit: 10,
          unit: "count",
          windowMinutes: 10_080,
        },
        {
          id: "mcp-monthly",
          label: "MCP",
          remaining: 10,
          limit: 10,
          unit: "count",
          windowMinutes: 43_200,
        },
      ],
      "zai",
    );
    assert.equal(renderProviderState(state), "Z.AI       90%    80%");
  });

  it("puts the only eligible window in long", () => {
    assert.equal(
      renderProviderState(readyState([percentBucket("day", 1_440, 25)])),
      "Codex        —    75%",
    );
  });

  it("uses input order to break tied durations and rates without mutating buckets", () => {
    const buckets = [percentBucket("first", 1_440, 20), percentBucket("second", 1_440, 10)];
    const before = structuredClone(buckets);
    assert.equal(renderProviderState(readyState(buckets)), "Codex      90%    80%");
    assert.deepEqual(buckets, before);
  });

  it("shows missing cells for unknown durations rather than inferring them from IDs or reset times", () => {
    const state = readyState([
      { id: "weekly", label: "Week", unit: "percent", remaining: 80, resetsAt: 1_800_000_000 },
      percentBucket("invalid", Number.NaN, 20),
      percentBucket("zero", 0, 20),
    ]);
    assert.equal(renderProviderState(state), "Codex        —      —");
  });

  it("shows unknown long without substituting a shorter known window", () => {
    const state = readyState([
      { id: "week", label: "Week", unit: "count", windowMinutes: 10_080 },
      percentBucket("day", 1_440, 20),
    ]);
    assert.equal(renderProviderState(state), "Codex      80%      —");
  });

  it("does not interpret unknown or zero-limit quantities as remaining capacity", () => {
    const state = readyState([
      { id: "day", label: "Day", unit: "usd", remaining: 0, limit: 0, windowMinutes: 1_440 },
      { id: "hour", label: "Hour", unit: "percent", remaining: Number.NaN, windowMinutes: 60 },
    ]);
    assert.equal(renderProviderState(state), "Codex        —      —");
  });

  it("derives missing remaining values from usage and rounds the resulting percentage", () => {
    const state = readyState([
      { id: "day", label: "Day", unit: "count", used: 1, limit: 3, windowMinutes: 1_440 },
      { id: "hour", label: "Hour", unit: "percent", used: 20.4, windowMinutes: 60 },
    ]);
    assert.equal(renderProviderState(state), "Codex      80%    67%");
  });

  it("keeps exhausted quotas distinct from missing data", () => {
    const state = readyState([percentBucket("day", 1_440, 100)]);
    assert.equal(renderProviderState(state), "Codex        —     0%");
  });

  for (const status of ["unsupported", "auth-unavailable", "query-failed"] as const) {
    it(`renders ${status} with missing cells rather than percentages`, () => {
      const state: ProviderUsageState = {
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        displayState: "configured",
        status,
        message: "Test reason.",
      };
      assert.equal(renderProviderState(state), "Codex        —      —");
    });
  }
});
