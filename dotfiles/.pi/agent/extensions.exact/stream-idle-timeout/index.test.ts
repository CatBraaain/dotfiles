import assert from "node:assert/strict";
import { beforeEach, describe, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import streamIdleTimeoutExtension, {
  __armIdleTimer,
  __resetIdleTimerState,
  IDLE_TIMEOUT_MS,
  realArmIdleTimer,
} from "./index.ts";

type FakeTimer = {
  ms: number;
  cancelled: boolean;
  fired: boolean;
  fire: () => void;
};

function createHarness() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const timers: FakeTimer[] = [];
  let abortCount = 0;

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  const context = {
    abort: () => {
      abortCount += 1;
    },
  };

  streamIdleTimeoutExtension(pi);
  __armIdleTimer.current = (ms, onFire) => {
    const timer: FakeTimer = {
      ms,
      cancelled: false,
      fired: false,
      fire: () => {
        if (timer.cancelled || timer.fired) return;
        timer.fired = true;
        timer.cancelled = true;
        onFire();
      },
    };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  const call = async (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, context);
    }
  };

  return { call, timers, abortCount: () => abortCount };
}

const providerRequest = { type: "before_provider_request", payload: {} };
const streamDelta = { type: "message_update", message: { role: "assistant" } };
const messageFinalized = { type: "message_end", message: { role: "assistant" } };

describe("stream-idle-timeout", () => {
  beforeEach(() => __resetIdleTimerState());

  it("before_provider_request で 300,000ms のタイマーが起動する", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);

    assert.equal(IDLE_TIMEOUT_MS, 300_000);
    assert.equal(harness.timers.length, 1);
    assert.equal(harness.timers[0]!.ms, IDLE_TIMEOUT_MS);
  });

  it("タイマー発火で ctx.abort() が呼ばれる", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);
    harness.timers[0]!.fire();

    assert.equal(harness.abortCount(), 1);
  });

  it("message_update ごとにタイマーをリセットする", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);
    await harness.call("message_update", streamDelta);

    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[0]!.cancelled, true);
    assert.equal(harness.timers[1]!.ms, IDLE_TIMEOUT_MS);

    // リセット前のタイマーを発火させても abort しない
    harness.timers[0]!.fire();
    assert.equal(harness.abortCount(), 0);
    harness.timers[1]!.fire();
    assert.equal(harness.abortCount(), 1);
  });

  it("message_end でタイマーを停止する", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);
    await harness.call("message_end", messageFinalized);

    assert.equal(harness.timers[0]!.cancelled, true);
    harness.timers[0]!.fire();
    assert.equal(harness.abortCount(), 0);
  });

  it("ツールループで次のリクエスト開始時に再起動する", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);
    await harness.call("message_end", messageFinalized);
    await harness.call("before_provider_request", providerRequest);

    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[1]!.cancelled, false);
    harness.timers[1]!.fire();
    assert.equal(harness.abortCount(), 1);
  });

  it("発火後も次のストリームで再び監視する", async () => {
    const harness = createHarness();
    await harness.call("before_provider_request", providerRequest);
    harness.timers[0]!.fire();
    await harness.call("before_provider_request", providerRequest);
    harness.timers[1]!.fire();

    assert.equal(harness.abortCount(), 2);
  });
});

describe("realArmIdleTimer", () => {
  it("指定時間の経過でコールバックが呼ばれる", async () => {
    let fired = false;
    realArmIdleTimer(10, () => {
      fired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fired, true);
  });

  it("cancel 後はコールバックが呼ばれない", async () => {
    let fired = false;
    const cancel = realArmIdleTimer(10, () => {
      fired = true;
    });
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fired, false);
  });
});
