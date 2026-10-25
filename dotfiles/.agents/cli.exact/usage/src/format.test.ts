import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { renderProviderState } from "./format";
import type { ProviderUsageState, UsageReport } from "./types";

const report: UsageReport = {
  providerId: "openai-codex",
  providerName: "OpenAI Codex",
  capturedAt: 1_700_000_000_000,
  source: "codex-pi-auth",
  semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
  accountLabel: "test-account",
  buckets: [
    {
      id: "codex:primary",
      label: "Primary limit",
      groupId: "codex",
      used: 25,
      remaining: 75,
      limit: 100,
      unit: "percent",
      windowMinutes: 300,
    },
  ],
  metrics: [{ id: "credits", label: "Credits", value: 12, unit: "count" }],
  notes: ["Plan: pro", "Usage may be delayed."],
};

describe("renderProviderState", () => {
  it("renders a ready report with title, account, semantics, padded labels and notes", () => {
    const output = renderProviderState({
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      displayState: "current",
      status: "ready",
      report,
    });
    const expected = [
      "OpenAI Codex Usage · Current",
      "Account: test-account",
      "Semantics: ChatGPT subscription limits",
      "",
      `${"5h limit:".padEnd(29)}[${"█".repeat(15)}${"░".repeat(5)}] 75% left`,
      `${"Credits:".padEnd(29)}12`,
      "Plan: pro",
      "Usage may be delayed.",
    ].join("\n");
    assert.equal(output, expected);
    assert.equal(output.includes("Fast mode"), false);
  });

  for (const [status, label] of [
    ["unsupported", "Unsupported"],
    ["auth-unavailable", "Authentication unavailable"],
    ["query-failed", "Query failed"],
  ] as const) {
    it(`renders ${status} as a single line`, () => {
      const state: ProviderUsageState = {
        providerId: "example",
        providerName: "Example",
        displayState: "configured",
        status,
        message: "Test reason.",
      };
      const output = renderProviderState(state);
      assert.equal(output, `Example · Configured · ${label}: Test reason.`);
      assert.equal(output.split("\n").length, 1);
    });
  }
});

describe("remaining provider formats", () => {
  it("renders Command Code spending caps and metrics", () => {
    const commandReport: UsageReport = {
      ...report,
      providerId: "command-code",
      providerName: "Command Code",
      buckets: [
        { id: "five-hour", label: "5h limit", used: 2, remaining: 8, limit: 10, unit: "usd" },
      ],
      metrics: [{ id: "requests", label: "Requests", value: 7, unit: "count" }],
      notes: undefined,
    };
    const output = renderProviderState({
      providerId: "command-code",
      providerName: "Command Code",
      displayState: "configured",
      status: "ready",
      report: commandReport,
    });
    assert.match(output, /Command Code Usage · Configured/);
    assert.match(output, /\$2\.00 of \$10\.00 used · 80% left/);
    assert.match(output, /Requests:\s+7/);
  });
  it("renders Z.AI percentage and count quotas", () => {
    const zaiReport: UsageReport = {
      ...report,
      providerId: "zai",
      providerName: "Z.AI",
      buckets: [
        ...report.buckets,
        { id: "mcp", label: "MCP", used: 2, remaining: 8, limit: 10, unit: "count" },
      ],
      metrics: [],
      notes: ["Plan: Pro"],
    };
    const output = renderProviderState({
      providerId: "zai",
      providerName: "Z.AI",
      displayState: "configured",
      status: "ready",
      report: zaiReport,
    });
    assert.match(output, /Z\.AI Usage · Configured/);
    assert.match(output, /75% left/);
    assert.match(output, /2 of 10 used · 8 left/);
    assert.match(output, /Plan: Pro/);
  });
});
