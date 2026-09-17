import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { isZaiConcurrencyLimited, isZaiProvider } from "./zai-concurrency.ts";

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
