import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  isZaiConcurrencyFailure,
  nextConsecutiveCount,
  nextRetryDelayMs,
  retryAfterOverrideMs,
} from "./index.ts";

const RAW_JSON_BODY =
  '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';

describe("isZaiConcurrencyFailure", () => {
  it("matches raw JSON bodies and message-only forms for zai providers", () => {
    assert.equal(isZaiConcurrencyFailure("zai", { message: RAW_JSON_BODY }), true);
    assert.equal(
      isZaiConcurrencyFailure("zai", { message: "Rate limit reached for requests" }),
      true,
    );
    assert.equal(
      isZaiConcurrencyFailure("zai-coding-cn", {
        message: "The service may be temporarily overloaded, please try again later",
      }),
      true,
    );
    assert.equal(
      isZaiConcurrencyFailure("zai", { message: "service may be Temporarily Overloaded" }),
      true,
    );
    assert.equal(
      isZaiConcurrencyFailure("zai", { message: '{"error":{"code":"1305","message":"overloaded"}}' }),
      true,
    );
  });

  it("rejects other providers", () => {
    assert.equal(isZaiConcurrencyFailure("openai-codex", { message: RAW_JSON_BODY }), false);
    assert.equal(isZaiConcurrencyFailure("", { message: RAW_JSON_BODY }), false);
  });

  it("rejects quota and unrelated failures", () => {
    assert.equal(
      isZaiConcurrencyFailure("zai", { message: '{"error":{"code":"1113","message":"quota exhausted"}}' }),
      false,
    );
    assert.equal(
      isZaiConcurrencyFailure("zai", { message: '{"error":{"code":"1308","message":"quota exhausted"}}' }),
      false,
    );
    assert.equal(isZaiConcurrencyFailure("zai", { message: "insufficient balance" }), false);
    assert.equal(isZaiConcurrencyFailure("zai", { message: "" }), false);
  });
});

describe("retryAfterOverrideMs", () => {
  it("keeps only positive finite provider delays", () => {
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: 1_000 }), 1_000);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: 0 }), null);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: -5 }), null);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: Number.NaN }), null);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: Number.POSITIVE_INFINITY }), null);
    assert.equal(retryAfterOverrideMs({ message: "x" }), null);
  });
});

describe("nextRetryDelayMs", () => {
  it("grows exponentially from the base and caps at the max (midpoint jitter)", () => {
    const mid = () => 0.5;
    assert.equal(nextRetryDelayMs(1, null, mid), RETRY_BASE_DELAY_MS);
    assert.equal(nextRetryDelayMs(2, null, mid), 10_000);
    assert.equal(nextRetryDelayMs(3, null, mid), 20_000);
    assert.equal(nextRetryDelayMs(4, null, mid), 40_000);
    assert.equal(nextRetryDelayMs(5, null, mid), RETRY_MAX_DELAY_MS);
    assert.equal(nextRetryDelayMs(50, null, mid), RETRY_MAX_DELAY_MS);
  });

  it("applies ±20% symmetric jitter around the capped value", () => {
    assert.equal(nextRetryDelayMs(5, null, () => 0), 48_000);
    assert.equal(nextRetryDelayMs(5, null, () => 1), 72_000);
    assert.equal(nextRetryDelayMs(1, null, () => 0), 4_000);
    assert.equal(nextRetryDelayMs(1, null, () => 1), 6_000);
  });

  it("uses a provider retry-after verbatim, without jitter", () => {
    assert.equal(nextRetryDelayMs(3, 2_500, () => 0), 2_500);
  });
});

describe("nextConsecutiveCount", () => {
  it("grows within one turn+step retry loop", () => {
    assert.equal(nextConsecutiveCount(undefined, 1, 1), 1);
    assert.equal(nextConsecutiveCount({ consecutive: 1, turn: 1, step: 2 }, 1, 2), 2);
    assert.equal(nextConsecutiveCount({ consecutive: 3, turn: 1, step: 2 }, 1, 2), 4);
  });

  it("restarts at 1 on a different step or turn", () => {
    assert.equal(nextConsecutiveCount({ consecutive: 3, turn: 1, step: 2 }, 1, 3), 1);
    assert.equal(nextConsecutiveCount({ consecutive: 3, turn: 1, step: 2 }, 2, 2), 1);
    assert.equal(nextConsecutiveCount({ consecutive: 3, turn: 1, step: 2 }, 2, 1), 1);
  });
});
