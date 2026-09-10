import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  isZaiConcurrencyLimited,
  isZaiProvider,
  nextRetryDelayMs,
  parseRetryAfterMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "./zai-concurrency.ts";

describe("isZaiProvider", () => {
  it("accepts the Z.AI global and China coding-plan providers", () => {
    assert.equal(isZaiProvider("zai"), true);
    assert.equal(isZaiProvider("zai-coding-cn"), true);
  });

  it("rejects other providers", () => {
    assert.equal(isZaiProvider("openai-codex"), false);
    assert.equal(isZaiProvider("openrouter"), false);
    assert.equal(isZaiProvider(undefined), false);
  });
});

describe("isZaiConcurrencyLimited", () => {
  it("matches the raw JSON body carrying code 1302", () => {
    const body = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';
    assert.equal(isZaiConcurrencyLimited(body), true);
  });

  it("matches the raw JSON body carrying code 1305", () => {
    const body =
      '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}';
    assert.equal(isZaiConcurrencyLimited(body), true);
  });

  it("matches the plain 1302 message text", () => {
    assert.equal(isZaiConcurrencyLimited("Rate limit reached for requests"), true);
  });

  it("matches the plain 1305 message text", () => {
    assert.equal(
      isZaiConcurrencyLimited("The service may be temporarily overloaded, please try again later"),
      true,
    );
  });

  it("does not match Z.AI quota codes", () => {
    const weekly =
      '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-01-01 00:00"}}';
    const balance =
      '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}';
    assert.equal(isZaiConcurrencyLimited(weekly), false);
    assert.equal(isZaiConcurrencyLimited(balance), false);
  });

  it("does not match generic rate-limit wording of other providers", () => {
    assert.equal(isZaiConcurrencyLimited("429 rate limit exceeded for gpt-5.6"), false);
    assert.equal(isZaiConcurrencyLimited("429 Too Many Requests"), false);
    assert.equal(isZaiConcurrencyLimited(" Anthropic rate_limit_error "), false);
  });

  it("returns false without an error message", () => {
    assert.equal(isZaiConcurrencyLimited(undefined), false);
    assert.equal(isZaiConcurrencyLimited(""), false);
  });
});

describe("nextRetryDelayMs", () => {
  it("returns the server-provided delay unchanged", () => {
    const delay = nextRetryDelayMs(1, 12_000, () => 0.5);
    assert.equal(delay, 12_000);
  });

  it("grows exponentially with consecutive errors", () => {
    const noJitter = () => 0.5;
    const first = nextRetryDelayMs(1, null, noJitter);
    const second = nextRetryDelayMs(2, null, noJitter);
    assert.equal(first, RETRY_BASE_DELAY_MS);
    assert.equal(second, RETRY_BASE_DELAY_MS * 2);
  });

  it("caps the exponential growth", () => {
    const delay = nextRetryDelayMs(20, null, () => 0.5);
    assert.equal(delay, RETRY_MAX_DELAY_MS);
  });

  it("applies jitter within ±20% of the unjittered delay", () => {
    const unjittered = 40_000;
    const shortest = nextRetryDelayMs(4, null, () => 0);
    const longest = nextRetryDelayMs(4, null, () => 1);
    assert.ok(shortest >= Math.round(unjittered * 0.8), `shortest ${shortest}`);
    assert.ok(longest <= Math.round(unjittered * 1.2), `longest ${longest}`);
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("parses delay seconds into ms", () => {
    assert.equal(parseRetryAfterMs("120", now), 120_000);
  });

  it("parses an HTTP-date into remaining ms", () => {
    assert.equal(parseRetryAfterMs("Wed, 01 Jan 2026 00:02:00 GMT", now), 120_000);
  });

  it("clamps negative remaining time to zero", () => {
    assert.equal(parseRetryAfterMs("Tue, 31 Dec 2025 23:58:00 GMT", now), 0);
  });

  it("returns null without a usable value", () => {
    assert.equal(parseRetryAfterMs(undefined, now), null);
    assert.equal(parseRetryAfterMs("", now), null);
    assert.equal(parseRetryAfterMs("soon", now), null);
  });
});
