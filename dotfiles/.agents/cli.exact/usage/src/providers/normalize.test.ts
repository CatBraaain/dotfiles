import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { normalizeCodexBackendPayload } from "./codex";
import { commandCodeOrgId, normalizeCommandCodeUsagePayload } from "./command-code";
import { normalizeZaiQuotaPayload, normalizeZaiSubscriptionPayload } from "./zai";
import { zaiPayloadError, zaiResponseError } from "./zai-errors";

const capturedAt = 1_700_000_000_000;

describe("subscription windows", () => {
  it("normalizes Codex windows and leaves absent windows and reset times absent", () => {
    const report = normalizeCodexBackendPayload(
      {
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
        credits: { has_credits: true, balance: "12" },
        plan_type: "pro",
      },
      capturedAt,
    );
    assert.equal(report.providerId, "openai-codex");
    assert.equal(report.capturedAt, capturedAt);
    assert.equal(report.buckets.length, 1);
    assert.deepEqual(report.buckets[0], {
      id: "codex:primary",
      label: "Primary limit",
      groupId: "codex",
      groupLabel: "Codex",
      modelKeys: ["codex", "Codex"],
      used: 25,
      remaining: 75,
      limit: 100,
      unit: "percent",
      windowMinutes: 300,
    });
    assert.deepEqual(report.notes, ["Plan: pro"]);
    assert.equal(report.metrics[0]?.value, 12);
  });

  it("does not turn a missing Codex percentage into a zero-usage window", () => {
    const report = normalizeCodexBackendPayload(
      { rate_limit: { primary_window: {} }, credits: { has_credits: false } },
      capturedAt,
    );
    assert.deepEqual(report.buckets, []);
    assert.throws(
      () => normalizeCodexBackendPayload({ rate_limit: { primary_window: {} } }, capturedAt),
      /no displayable/,
    );
  });

  it("normalizes Command Code credits and drops an incomplete rolling window", () => {
    const report = normalizeCommandCodeUsagePayload(
      {
        account: { user: { userName: "tester" }, org: { id: "org-1" } },
        credits: {
          credits: { monthlyCredits: 10, purchasedCredits: 2 },
          windowLimits: { fiveHour: { used: 2, cap: 10 }, weekly: { cap: 100 } },
        },
        usage: { totalCost: 8, totalTokensIn: 100 },
      },
      capturedAt,
    );
    assert.deepEqual(
      report.buckets.map((bucket) => bucket.id),
      ["five-hour", "monthly"],
    );
    assert.equal(report.buckets[1]?.limit, 20);
    assert.equal(
      report.metrics.some((metric) => metric.id === "requests"),
      false,
    );
    assert.equal(commandCodeOrgId({ org: { id: "../unsafe" } }), undefined);
    assert.ok(report.notes?.includes("Command Code plan details were unavailable."));
  });

  for (const resetAt of [1793511054, "1793511054", 1793511054000, "1793511054000"]) {
    it("normalizes positive Command Code reset seconds and milliseconds: " + resetAt, () => {
      const report = normalizeCommandCodeUsagePayload(
        {
          account: { user: { userName: "tester" } },
          credits: {
            windowLimits: {
              fiveHour: { used: 1, cap: 3, resetAt },
              weekly: { used: 2, cap: 6, resetAt },
            },
          },
        },
        capturedAt,
      );
      assert.deepEqual(
        report.buckets.map((bucket) => bucket.resetsAt),
        [1793511054, 1793511054],
      );
      assert.deepEqual(
        report.buckets.map((bucket) => bucket.remaining),
        [2, 4],
      );
    });
  }

  it("normalizes Z.AI percent and count windows without creating missing quotas", () => {
    const report = normalizeZaiQuotaPayload(
      "zai",
      "Z.AI",
      {
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 12 },
            { type: "TOKENS_LIMIT", unit: 6, currentValue: 40, usage: 100 },
            { type: "TIME_LIMIT", usage: 100 },
          ],
        },
      },
      capturedAt,
      { name: "Pro" },
    );
    assert.deepEqual(
      report.buckets.map((bucket) => bucket.remaining),
      [88, 60],
    );
    assert.equal(
      report.buckets.every((bucket) => !Object.hasOwn(bucket, "resetsAt")),
      true,
    );
    assert.deepEqual(report.notes, ["Plan: Pro"]);
    assert.deepEqual(
      normalizeZaiSubscriptionPayload({
        data: [
          { productName: "Expired", status: "EXPIRED" },
          { productName: "Current", status: "VALID", inCurrentPeriod: true },
        ],
      }),
      { name: "Current" },
    );
  });
});

describe("safe provider errors", () => {
  it("never includes provider error text in Z.AI errors", () => {
    const payload = { error: { code: 1000, message: "secret-value\u001b[31m" } };
    assert.equal(zaiPayloadError(payload), "Z.AI 1000: Authentication failed. Check your API key.");
    assert.equal(
      zaiResponseError(401, JSON.stringify(payload)),
      "Z.AI 1000: Authentication failed. Check your API key.",
    );
    assert.equal(
      zaiResponseError(200, "secret-value invalid json"),
      "Z.AI: Invalid JSON response.",
    );
  });
});
