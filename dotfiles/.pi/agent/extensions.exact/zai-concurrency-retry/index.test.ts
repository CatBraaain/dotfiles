import assert from "node:assert/strict";
import { beforeEach, describe, it } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import zaiConcurrencyRetryExtension, {
  __random,
  __resetRetryState,
  __sleep,
  realSleepMs,
  RETRY_MESSAGE_PREFIX,
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

  zaiConcurrencyRetryExtension(pi);
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
      key: "zai-concurrency-retry",
      text: "Z.AI concurrency limit; retrying in 5s (attempt 1)",
    });
    assert.deepEqual(harness.statuses.at(-1), {
      key: "zai-concurrency-retry",
      text: undefined,
    });
  });

  it("書き換え後の文言は pi-ai の retryable 判定を満たす", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(harness, concurrencyError());

    assert.equal(isRetryableAssistantError(replacement!.message as never), true);
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

  it("z-ai 以外のプロバイダは対象外", async () => {
    const harness = createHarness();
    const replacement = await messageEnd(
      harness,
      concurrencyError({ provider: "openai-codex", model: "gpt-5.6" }),
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

  it("Z.AI の Retry-After ヘッダーを次の待機に使う", async () => {
    const harness = createHarness();
    await harness.call("after_provider_response", {
      status: 429,
      headers: { "retry-after": "30" },
    });
    await messageEnd(harness, concurrencyError());

    assert.deepEqual(harness.waitedMs, [30_000]);
  });

  it("Retry-After なしの 429 は既定のバックオフに戻る", async () => {
    const harness = createHarness();
    await harness.call("after_provider_response", { status: 429, headers: {} });
    await messageEnd(harness, concurrencyError());

    assert.deepEqual(harness.waitedMs, [5000]);
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
    assert.equal(message.customType, "zai-concurrency-retry");
    assert.equal(message.display, false);
    assert.equal(options.triggerTurn, true);
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

    assert.deepEqual(harness.notifications, ["Z.AI concurrency limit; retrying in 5s (attempt 1)"]);
  });
});
