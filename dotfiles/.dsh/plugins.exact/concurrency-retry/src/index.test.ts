import { Context } from "@deepseek-ai/cordis";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONCURRENCY_RETRY_WAIT_EVENT_TYPE,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  apply,
  inject,
  isConcurrencyFailure,
  nextConsecutiveCount,
  nextRetryDelayMs,
  retryAfterOverrideMs,
} from "./index.ts";
import { CONCURRENCY_RETRY_WAIT_EVENT_TYPE as CLIENT_EVENT_TYPE } from "./client/event";

const RAW_ZAI_BODY = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';

describe("isConcurrencyFailure", () => {
  it("matches confirmed Z.AI code and message evidence", () => {
    assert.equal(isConcurrencyFailure("zai", { message: RAW_ZAI_BODY }), true);
    assert.equal(
      isConcurrencyFailure("zai-coding-cn", { message: "temporarily overloaded" }),
      true,
    );
    assert.equal(
      isConcurrencyFailure("zai", {
        message: "adapter error",
        response: { error: { code: "1305", message: "overloaded" } },
      }),
      true,
    );
  });

  it("matches explicit concurrency evidence for catalog and hand-declared routes", () => {
    assert.equal(
      isConcurrencyFailure("catalog-provider", { message: "concurrent requests exceeded" }),
      true,
    );
    assert.equal(
      isConcurrencyFailure("commandcode", { message: "connection limit reached" }),
      true,
    );
  });

  it("rejects quota, billing, usage-window, and unrelated failures first", () => {
    const rejected = [
      { message: '{"error":{"code":"1113","message":"quota exhausted"}}' },
      { message: '{"error":{"code":1321,"message":"temporarily overloaded"}}' },
      { message: "temporarily overloaded", response: { error: { code: 1308 } } },
      { message: "temporarily overloaded", code: "1308" },
      { message: "concurrent requests exceeded; monthly limit reached" },
      { message: "concurrent requests exceeded; weekly limit reached" },
      { message: "concurrent requests exceeded; billing balance unavailable" },
      { message: "concurrent requests exceeded; credit exhausted" },
      { message: "concurrent requests exceeded; usage-window exhausted" },
      { message: "429" },
      { message: "RATE_LIMIT" },
      { message: "Retry-After: 15" },
      { message: "Monthly usage limit reached" },
      { message: "available balance is too low" },
      { message: "insufficient_quota" },
    ];
    for (const failure of rejected) {
      assert.equal(isConcurrencyFailure("zai", failure), false, failure.message);
      assert.equal(isConcurrencyFailure("catalog-provider", failure), false, failure.message);
    }
  });

  it("does not infer a Codex or Command Code concurrency error from shared rate-limit facts", () => {
    assert.equal(isConcurrencyFailure("openai-codex", { message: "429 RATE_LIMIT" }), false);
    assert.equal(isConcurrencyFailure("commandcode", { message: "RATE_LIMIT" }), false);
    // The Codex adapter absorbs websocket_connection_limit_reached before the
    // terminal request-error boundary, so no Codex-specific terminal fixture
    // is treated as evidence here.
    assert.equal(
      isConcurrencyFailure("openai-codex", { message: "websocket_connection_limit_reached" }),
      false,
    );
  });
});

describe("retryAfterOverrideMs", () => {
  it("keeps only positive finite provider delays", () => {
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: 1_000 }), 1_000);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: 0 }), null);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: -5 }), null);
    assert.equal(retryAfterOverrideMs({ message: "x", providerRetryAfterMs: Number.NaN }), null);
    assert.equal(
      retryAfterOverrideMs({ message: "x", providerRetryAfterMs: Number.POSITIVE_INFINITY }),
      null,
    );
    assert.equal(retryAfterOverrideMs({ message: "x" }), null);
  });
});

describe("nextRetryDelayMs", () => {
  it("grows exponentially from the base and caps at the max", () => {
    const mid = () => 0.5;
    assert.equal(nextRetryDelayMs(1, null, mid), RETRY_BASE_DELAY_MS);
    assert.equal(nextRetryDelayMs(2, null, mid), 10_000);
    assert.equal(nextRetryDelayMs(3, null, mid), 20_000);
    assert.equal(nextRetryDelayMs(4, null, mid), 40_000);
    assert.equal(nextRetryDelayMs(5, null, mid), RETRY_MAX_DELAY_MS);
    assert.equal(nextRetryDelayMs(50, null, mid), RETRY_MAX_DELAY_MS);
  });

  it("applies ±20% symmetric jitter around the capped value", () => {
    assert.equal(
      nextRetryDelayMs(5, null, () => 0),
      48_000,
    );
    assert.equal(
      nextRetryDelayMs(5, null, () => 1),
      72_000,
    );
    assert.equal(
      nextRetryDelayMs(1, null, () => 0),
      4_000,
    );
    assert.equal(
      nextRetryDelayMs(1, null, () => 1),
      6_000,
    );
  });

  it("uses a provider retry-after verbatim, without jitter", () => {
    assert.equal(
      nextRetryDelayMs(3, 2_500, () => 0),
      2_500,
    );
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
  interface CapturedHandler {
    (payload: Record<string, any>, next: () => Promise<unknown>): Promise<unknown>;
  }

  interface AppendCall {
    type: string;
    data: { provider: string; attempt: number; waitMs: number };
  }

  function captureHandler(initialRoutes: string[] = ["zai"]): {
    handler: CapturedHandler;
    appended: AppendCall[];
    warnings: string[];
    routes: string[];
    options: Record<string, unknown> | undefined;
    refresh: () => void;
  } {
    const handlers: Record<string, CapturedHandler> = {};
    const appended: AppendCall[] = [];
    const warnings: string[] = [];
    const routes = [...initialRoutes];
    let options: Record<string, unknown> | undefined;
    const ctx = {
      llm: { listProviders: () => routes.map((id) => ({ id, name: id })) },
      on: (name: string, handler: CapturedHandler, listenerOptions?: Record<string, unknown>) => {
        handlers[name] = handler;
        if (name === "agent/request-error") options = listenerOptions;
      },
      logger: () => ({ warn: (message: string) => warnings.push(message) }),
    };
    apply(ctx as never);
    const handler = handlers["agent/request-error"];
    if (handler === undefined) throw new Error("agent/request-error handler not registered");
    return {
      handler,
      appended,
      warnings,
      routes,
      options,
      refresh: () =>
        handlers["llm/adapters-updated"]?.({} as never, (() => Promise.resolve()) as never),
    };
  }

  function payload(
    session: { append: (type: string, data: AppendCall["data"]) => void },
    signal: AbortSignal,
    provider = "zai",
    message = "Rate limit reached for requests",
    retryAfterMs?: number,
  ): Record<string, unknown> {
    return {
      agent: { session },
      turn: 1,
      step: 2,
      provider,
      failure: {
        message,
        ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
      },
      signal,
    };
  }

  it("uses a general event type and registers request recovery with prepend priority", () => {
    const captured = captureHandler();
    assert.equal(CLIENT_EVENT_TYPE, CONCURRENCY_RETRY_WAIT_EVENT_TYPE);
    assert.equal(captured.options?.prepend, true);
  });

  it("declares the LLM service and keeps the generated client bundle aligned", () => {
    assert.deepEqual(inject, ["llm"]);
    const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    assert.match(bundle, /id: "dotfiles-dsh-concurrency-retry"/);
    assert.match(bundle, /concurrency-retry\/wait/);
    assert.doesNotMatch(bundle, /zai-concurrency-retry/);
  });

  it("returns retry after waiting without calling next", async () => {
    const captured = captureHandler(["catalog-provider"]);
    const session = { append: () => {} };
    let nextCalls = 0;
    const result = await captured.handler(
      payload(
        session,
        new AbortController().signal,
        "catalog-provider",
        "concurrent requests exceeded",
        1,
      ),
      () => {
        nextCalls += 1;
        return Promise.resolve({ kind: "fail" });
      },
    );
    assert.deepEqual(result, { kind: "retry" });
    assert.equal(nextCalls, 0);
  });

  it("retries matching failures without calling next and appends one wait event", async () => {
    const captured = captureHandler(["catalog-provider"]);
    const session = {
      append: (type: string, data: AppendCall["data"]) => captured.appended.push({ type, data }),
    };
    const controller = new AbortController();
    const pending = captured.handler(
      payload(session, controller.signal, "catalog-provider", "concurrent requests exceeded"),
      () => {
        throw new Error("matching failure reached downstream");
      },
    );
    await Promise.resolve();
    controller.abort();
    assert.equal(await pending, undefined);
    await Promise.resolve();
    assert.equal(captured.appended.length, 1);
    assert.equal(captured.appended[0].type, "concurrency-retry/wait");
    assert.equal(captured.appended[0].data.provider, "catalog-provider");
    assert.equal(captured.warnings.length, 1);
  });

  it("delegates non-match and quota failures exactly once", async () => {
    const captured = captureHandler();
    const session = { append: () => {} };
    let nextCalls = 0;
    const delegated = { kind: "fail" } as const;
    for (const failure of [
      { provider: "commandcode", message: "429 RATE_LIMIT" },
      { provider: "zai", message: "concurrent requests exceeded; usage window reset" },
      { provider: "unknown", message: "concurrent requests exceeded" },
    ]) {
      const result = await captured.handler(
        payload(session, new AbortController().signal, failure.provider, failure.message),
        () => {
          nextCalls += 1;
          return Promise.resolve(delegated);
        },
      );
      assert.equal(result, delegated);
    }
    await Promise.resolve();
    assert.equal(nextCalls, 3);
    assert.equal(captured.appended.length, 0);
    assert.equal(captured.warnings.length, 0);
  });

  it("keeps matching failures out of the real waterfall while delegating quota failures", async () => {
    const ctx = new Context();
    const disposeLlm = ctx.provide("llm", {
      listProviders: () => [{ id: "catalog-provider", name: "Catalog Provider" }],
    });
    let agentsCalls = 0;
    ctx.on("agent/request-error", async (_payload, next) => {
      agentsCalls += 1;
      return next();
    });
    apply(ctx);
    const session = { append: () => {} };
    const agent = { session };
    try {
      const matching = await ctx.waterfall(
        "agent/request-error",
        {
          agent,
          turn: 1,
          step: 1,
          provider: "catalog-provider",
          failure: { message: "concurrent requests exceeded" },
          signal: AbortSignal.abort(),
        },
        () => Promise.resolve({ kind: "fail" }),
      );
      assert.equal(matching, undefined);
      assert.equal(agentsCalls, 0);

      const delegated = await ctx.waterfall(
        "agent/request-error",
        {
          agent,
          turn: 1,
          step: 2,
          provider: "catalog-provider",
          failure: { message: "concurrent requests exceeded; usage-window exhausted" },
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: "fail" }),
      );
      assert.deepEqual(delegated, { kind: "fail" });
      assert.equal(agentsCalls, 1);
    } finally {
      disposeLlm();
      await ctx.fiber.dispose();
    }
  });

  it("refreshes the active route snapshot after adapters change", async () => {
    const captured = captureHandler(["catalog-provider"]);
    captured.routes.splice(0, 1, "hand-declared");
    captured.refresh();
    const session = { append: () => {} };
    let nextCalls = 0;
    const controller = new AbortController();
    const pending = captured.handler(
      payload(session, controller.signal, "hand-declared", "concurrent requests exceeded"),
      () => {
        nextCalls += 1;
        return Promise.resolve({ kind: "fail" });
      },
    );
    await Promise.resolve();
    controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(nextCalls, 0);

    captured.routes.splice(0, 1);
    captured.refresh();
    const delegated = await captured.handler(
      payload(
        session,
        new AbortController().signal,
        "hand-declared",
        "concurrent requests exceeded",
      ),
      () => {
        nextCalls += 1;
        return Promise.resolve({ kind: "fail" });
      },
    );
    assert.deepEqual(delegated, { kind: "fail" });
    assert.equal(nextCalls, 1);
  });
});
