import assert from "node:assert/strict";
import { beforeEach, describe, it } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import concurrencyRetryExtension, {
  __random,
  __resetRetryState,
  __sleep,
  isConcurrencyError,
  parseRetryAfterMs,
  realSleepMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_MESSAGE_PREFIX,
  nextRetryDelayMs,
} from "./index.ts";

function createHarness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: string[] = [];
  const waitedMs: number[] = [];

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;

  const abortController = new AbortController();
  let isIdle = true;
  let hasPendingMessages = false;
  const context = {
    hasUI: true,
    signal: abortController.signal,
    isIdle: () => isIdle,
    hasPendingMessages: () => hasPendingMessages,
    model: { provider: "zai", id: "glm-5.2" },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      notify: (message: string) => notifications.push(message),
    },
  };

  concurrencyRetryExtension(pi);
  __sleep.current = async (ms: number) => {
    waitedMs.push(ms);
    return !abortController.signal.aborted;
  };
  __random.current = () => 0.5;

  // Runs every handler registered for the event and returns the last defined
  // result (message_end replacements).
  const call = async (event: string, payload: unknown) => {
    let lastResult: unknown;
    for (const handler of handlers.get(event) ?? []) {
      const result = await handler(payload, context);
      if (result !== undefined) lastResult = result;
    }
    return lastResult;
  };

  return {
    call,
    sentMessages,
    statuses,
    notifications,
    waitedMs,
    setIsIdle: (value: boolean) => (isIdle = value),
    setHasPendingMessages: (value: boolean) => (hasPendingMessages = value),
    abort: () => abortController.abort(),
  };
}

function concurrencyError(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    stopReason: "error",
    provider: "zai",
    model: "glm-5.2",
    errorMessage: "Rate limit reached for requests",
    ...overrides,
  };
}

async function messageEnd(harness: ReturnType<typeof createHarness>, message: unknown) {
  const result = await harness.call("message_end", { type: "message_end", message });
  return result as { message: { errorMessage: string } } | undefined;
}

describe("isConcurrencyError", () => {
  it("matches Z.AI concurrency codes in a raw JSON body", () => {
    const body1302 = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';
    const body1305 =
      '{"error":{"code":"1305","message":"The service may be temporarily overloaded, please try again later"}}';
    assert.equal(isConcurrencyError("zai", body1302), true);
    assert.equal(isConcurrencyError("zai", body1305), true);
  });

  it("matches the plain Z.AI message wording", () => {
    assert.equal(isConcurrencyError("zai", "Rate limit reached for requests"), true);
    assert.equal(
      isConcurrencyError("zai", "The service may be temporarily overloaded, please try again later"),
      true,
    );
    assert.equal(isConcurrencyError("zai-coding-cn", "Rate limit reached for requests"), true);
  });

  it("does not match Z.AI quota codes or quota wording", () => {
    const weekly =
      '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-01-01 00:00"}}';
    const balance =
      '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}';
    assert.equal(isConcurrencyError("zai", weekly), false);
    assert.equal(isConcurrencyError("zai", balance), false);
    assert.equal(isConcurrencyError("zai", "You have exceeded your monthly quota"), false);
  });

  it("does not apply the generic matcher to providers with a dedicated rule", () => {
    assert.equal(isConcurrencyError("zai", "Too many concurrent requests"), false);
  });

  it("matches generic concurrency wording for other providers", () => {
    assert.equal(isConcurrencyError("openai-codex", "Too many concurrent requests"), true);
    assert.equal(
      isConcurrencyError("openrouter", "connection limit reached for this account"),
      true,
    );
    assert.equal(isConcurrencyError("commandcode", "a concurrency limit has been reached"), true);
  });

  it("does not match non-concurrency or rate-limit-only wording for other providers", () => {
    assert.equal(isConcurrencyError("openai-codex", "Connection refused"), false);
    assert.equal(isConcurrencyError("openai-codex", "429 Too Many Requests"), false);
    assert.equal(isConcurrencyError("openai-codex", "rate limit exceeded"), false);
    assert.equal(isConcurrencyError("openrouter", "insufficient_quota: usage window exhausted"), false);
  });

  it("returns false without an error message", () => {
    assert.equal(isConcurrencyError("zai", undefined), false);
    assert.equal(isConcurrencyError("zai", ""), false);
  });
});

describe("ターン内リトライ", () => {
  beforeEach(() => __resetRetryState());

  it("同時実行エラーを待機してから retryable な文言へ書き換える", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(harness, concurrencyError());

    const replacedError: string = replacement!.message.errorMessage;
    assert.ok(replacedError.startsWith(RETRY_MESSAGE_PREFIX), replacedError);
    assert.ok(replacedError.includes("Rate limit reached for requests"), replacedError);
    assert.deepEqual(harness.waitedMs, [5000]);
    // 待機開始でステータス表示、完了で消える
    assert.deepEqual(harness.statuses[0], {
      key: "concurrency-retry",
      text: "zai concurrency limit; retrying in 5s (attempt 1)",
    });
    assert.deepEqual(harness.statuses.at(-1), {
      key: "concurrency-retry",
      text: undefined,
    });
  });

  it("書き換え後の文言は pi-ai の retryable 判定を満たす", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(harness, concurrencyError());

    assert.equal(isRetryableAssistantError(replacement!.message as never), true);
  });

  it("他プロバイダの汎用 concurrency 文言も書き換える", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(
      harness,
      concurrencyError({
        provider: "openai-codex",
        model: "gpt-5.6",
        errorMessage: "Too many concurrent requests; please retry later",
      }),
    );

    assert.ok(replacement, "expected a replacement message");
    assert.equal(isRetryableAssistantError(replacement!.message as never), true);
    assert.deepEqual(harness.statuses[0], {
      key: "concurrency-retry",
      text: "openai-codex concurrency limit; retrying in 5s (attempt 1)",
    });
  });

  it("待機中に abort されたら書き換えず元のエラーを通す", async () => {
    const harness = createHarness();
    harness.abort();
    const replacement = await messageEnd(harness, concurrencyError());

    assert.equal(replacement, undefined);
  });

  it("成功メッセージで連続回数がリセットされる", async () => {
    const harness = createHarness();
    await messageEnd(harness, concurrencyError());
    await messageEnd(harness, concurrencyError());
    await messageEnd(harness, concurrencyError({ stopReason: "stop", errorMessage: undefined }));

    await messageEnd(harness, concurrencyError());
    assert.deepEqual(harness.waitedMs.at(-1), 5000);
  });

  it("abort で確定したメッセージでも連続回数がリセットされる", async () => {
    const harness = createHarness();
    await messageEnd(harness, concurrencyError());
    await messageEnd(harness, concurrencyError({ stopReason: "aborted", errorMessage: undefined }));

    await messageEnd(harness, concurrencyError());
    assert.deepEqual(harness.waitedMs.at(-1), 5000);
  });

  it("quota 系エラーは対象外", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(
      harness,
      concurrencyError({
        errorMessage: '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}',
      }),
    );

    assert.equal(replacement, undefined);
    assert.deepEqual(harness.waitedMs, []);
  });

  it("汎用 concurrency 文言のない他プロバイダは対象外", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(
      harness,
      concurrencyError({ provider: "openai-codex", model: "gpt-5.6", errorMessage: "Connection refused" }),
    );

    assert.equal(replacement, undefined);
    assert.deepEqual(harness.waitedMs, []);
  });

  it("zai では汎用文言だけでは対象外", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(
      harness,
      concurrencyError({ errorMessage: "Too many concurrent requests" }),
    );

    assert.equal(replacement, undefined);
    assert.deepEqual(harness.waitedMs, []);
  });
});

describe("待機時間", () => {
  beforeEach(() => __resetRetryState());

  it("連続回数に応じて待機が伸び、上限で頭打ちになる", async () => {
    const harness = createHarness();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await messageEnd(harness, concurrencyError());
    }

    assert.deepEqual(harness.waitedMs, [5000, 10000, 20000, 40000, 60000]);
  });

  it("429 の Retry-After ヘッダーを次の待機に使う（プロバイダを問わない）", async () => {
    const harness = createHarness();
    await harness.call("after_provider_response", {
      status: 429,
      headers: { "retry-after": "30" },
    });
    await messageEnd(
      harness,
      concurrencyError({ provider: "openai-codex", errorMessage: "Too many concurrent requests" }),
    );

    assert.deepEqual(harness.waitedMs, [30_000]);
  });

  it("Retry-After なしの 429 は既定のバックオフに戻る", async () => {
    const harness = createHarness();
    await harness.call("after_provider_response", { status: 429, headers: {} });
    await messageEnd(harness, concurrencyError());

    assert.deepEqual(harness.waitedMs, [5000]);
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

describe("realSleepMs", () => {
  it("abort されたら指定時間を待たずに中断する", async () => {
    const controller = new AbortController();
    const wait = realSleepMs(5000, controller.signal);
    setTimeout(() => controller.abort(), 10);

    assert.equal(await wait, false);
  });

  it("abort されずに時間が経過したら完了する", async () => {
    const result = await realSleepMs(1, undefined);

    assert.equal(result, true);
  });

  it("すでに abort されたシグナルでは即座に中断する", async () => {
    const result = await realSleepMs(5000, AbortSignal.abort());

    assert.equal(result, false);
  });
});

describe("agent_settled での turn 再実行", () => {
  beforeEach(() => __resetRetryState());

  it("同時実行エラーで終わった turn を待機後に再実行する", async () => {
    const harness = createHarness();
    await harness.call("agent_end", { messages: [concurrencyError()] });
    await harness.call("agent_settled", {});

    assert.equal(harness.sentMessages.length, 1);
    const { message, options } = harness.sentMessages[0] as {
      message: { customType: string; display: boolean };
      options: { triggerTurn: boolean };
    };
    assert.equal(message.customType, "concurrency-retry");
    assert.equal(message.display, false);
    assert.equal(options.triggerTurn, true);
  });

  it("他プロバイダの汎用 concurrency エラーでも再実行する", async () => {
    const harness = createHarness();
    await harness.call("agent_end", {
      messages: [
        concurrencyError({
          provider: "openai-codex",
          model: "gpt-5.6",
          errorMessage: "Too many concurrent requests; please retry later",
        }),
      ],
    });
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.notifications, [
      "openai-codex concurrency limit; retrying in 5s (attempt 1)",
    ]);
    assert.equal(harness.sentMessages.length, 1);
  });

  it("再実行の待機は turn 内の連続回数を引き継ぐ", async () => {
    const harness = createHarness();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await messageEnd(harness, concurrencyError());
    }
    await harness.call("agent_end", { messages: [concurrencyError()] });
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.waitedMs.at(-1), 60000);
  });

  it("abort で終わった turn は再実行しない", async () => {
    const harness = createHarness();
    await harness.call("agent_end", {
      messages: [concurrencyError({ stopReason: "aborted", errorMessage: undefined })],
    });
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.sentMessages, []);
  });

  it("他のエラーで終わった turn は再実行しない", async () => {
    const harness = createHarness();
    await harness.call("agent_end", {
      messages: [concurrencyError({ errorMessage: "Connection refused" })],
    });
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.sentMessages, []);
  });

  it("保留メッセージがある場合は再実行しない", async () => {
    const harness = createHarness();
    await harness.call("agent_end", { messages: [concurrencyError()] });
    harness.setHasPendingMessages(true);
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.sentMessages, []);
  });

  it("待機中に idle でなくなったら再実行しない", async () => {
    const harness = createHarness();
    await harness.call("agent_end", { messages: [concurrencyError()] });
    harness.setIsIdle(false);
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.sentMessages, []);
  });

  it("待機中はステータスと通知で再試行を伝える", async () => {
    const harness = createHarness();
    await harness.call("agent_end", { messages: [concurrencyError()] });
    await harness.call("agent_settled", {});

    assert.deepEqual(harness.notifications, ["zai concurrency limit; retrying in 5s (attempt 1)"]);
  });
});
