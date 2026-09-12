import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  ZAI_RETRY_WAIT_EVENT_TYPE,
  apply,
  isZaiConcurrencyFailure,
  nextConsecutiveCount,
  nextRetryDelayMs,
  retryAfterOverrideMs,
} from "./index.ts";
import { ZAI_RETRY_WAIT_EVENT_TYPE as CLIENT_EVENT_TYPE } from "./client/event";

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

describe("apply (agent/request-error)", () => {
  /** Minimal shapes the handler reads: session.append, logger.warn, ctx.on. */
  interface CapturedHandler {
    (payload: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown>;
  }

  interface AppendCall {
    type: string;
    data: { provider: string; attempt: number; waitMs: number };
  }

  function captureHandler(): {
    handler: CapturedHandler;
    appended: AppendCall[];
    warnings: string[];
  } {
    const handlers: Record<string, CapturedHandler> = {};
    const appended: AppendCall[] = [];
    const warnings: string[] = [];
    const ctx = {
      on: (name: string, handler: CapturedHandler) => {
        handlers[name] = handler;
      },
      logger: () => ({
        warn: (message: string) => warnings.push(message),
      }),
    };
    apply(ctx as never);
    const handler = handlers["agent/request-error"];
    if (handler === undefined) throw new Error("agent/request-error handler not registered");
    return { handler, appended, warnings };
  }

  function concurrencyPayload(
    session: { append: (type: string, data: AppendCall["data"]) => void },
    signal: AbortSignal,
  ): Record<string, unknown> {
    return {
      agent: { session },
      turn: 1,
      step: 2,
      provider: "zai",
      failure: { message: "Rate limit reached for requests" },
      signal,
    };
  }

  it("keeps the host and client event type literals identical", () => {
    assert.equal(CLIENT_EVENT_TYPE, ZAI_RETRY_WAIT_EVENT_TYPE);
  });

  it("appends one wait event per matching failure, with the growing attempt count", async () => {
    const { handler, appended, warnings } = captureHandler();
    const session = {
      append: (type: string, data: AppendCall["data"]) => {
        appended.push({ type, data });
      },
    };
    // One agent object across both failures: retry chains key on the agent.
    const agent = { session };
    let controller = new AbortController();

    // Two consecutive failures in the same turn+step: attempts 1 then 2.
    for (const _ of [0, 1]) {
      const pending = handler(
        { ...concurrencyPayload(session, controller.signal), agent },
        () => Promise.resolve({ kind: "fail" }),
      );
      // Flush the microtask the append is deferred to; abort the wait right
      // after so no real timer outlives the test.
      await Promise.resolve();
      controller.abort();
      await pending;
      controller = new AbortController();
    }

    assert.equal(appended.length, 2);
    assert.equal(warnings.length, 2);
    // Attempt n waits 5s × 2^(n-1) ±20% jitter: 4-6s then 8-12s.
    const jitterRanges = [
      [4_000, 6_000],
      [8_000, 12_000],
    ] as const;
    for (const [index, call] of appended.entries()) {
      assert.equal(call.type, "zai-concurrency-retry/wait");
      assert.equal(call.data.provider, "zai");
      const [min, max] = jitterRanges[index];
      assert.ok(
        call.data.waitMs >= min && call.data.waitMs <= max,
        `attempt-${index + 1} waitMs within the jitter range: ${call.data.waitMs}`,
      );
      assert.equal(call.data.attempt, index + 1);
    }
  });

  it("does not append for non-matching failures", async () => {
    const { handler, appended } = captureHandler();
    const session = {
      append: (type: string, data: AppendCall["data"]) => {
        appended.push({ type, data });
      },
    };
    const delegated = { kind: "fail" } as const;
    let nextCalls = 0;

    const result = await handler(
      { ...concurrencyPayload(session, new AbortController().signal), provider: "openai-codex" },
      () => {
        nextCalls += 1;
        return Promise.resolve(delegated);
      },
    );
    await Promise.resolve();

    assert.equal(result, delegated);
    assert.equal(nextCalls, 1);
    assert.equal(appended.length, 0);
  });
});
