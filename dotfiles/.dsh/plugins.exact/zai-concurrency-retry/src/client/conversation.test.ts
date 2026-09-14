import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { waitEventData, zaiRetryWaitDefinition } from "./conversation";
import { ZAI_RETRY_WAIT_EVENT_TYPE } from "./event";

const VALID_DATA = { provider: "zai", attempt: 2, waitMs: 30_000 };

/** Minimal event shape the Definition's match/start consume. */
function waitEvent(seq: number, data: unknown) {
  return {
    type: ZAI_RETRY_WAIT_EVENT_TYPE,
    seq,
    time: 0,
    data,
  } as Parameters<typeof zaiRetryWaitDefinition.match>[0];
}

describe("waitEventData", () => {
  it("passes a valid payload through", () => {
    assert.deepEqual(waitEventData(VALID_DATA), VALID_DATA);
  });

  it("rejects malformed payloads", () => {
    assert.equal(waitEventData(undefined), undefined);
    assert.equal(waitEventData({}), undefined);
    assert.equal(waitEventData({ ...VALID_DATA, provider: "" }), undefined);
    assert.equal(waitEventData({ ...VALID_DATA, attempt: 0 }), undefined);
    assert.equal(waitEventData({ ...VALID_DATA, waitMs: 0 }), undefined);
    assert.equal(waitEventData({ ...VALID_DATA, waitMs: Number.NaN }), undefined);
  });
});

describe("zaiRetryWaitDefinition.match", () => {
  it("accepts a wait event as a start keyed by seq", () => {
    assert.deepEqual(zaiRetryWaitDefinition.match(waitEvent(7, VALID_DATA)), {
      id: "wait-7",
      role: "start",
    });
  });

  it("rejects other event types and malformed payloads", () => {
    assert.equal(
      zaiRetryWaitDefinition.match({ ...waitEvent(7, VALID_DATA), type: "llm/retry" } as never),
      null,
    );
    assert.equal(zaiRetryWaitDefinition.match(waitEvent(7, { provider: "zai" })), null);
  });
});

describe("zaiRetryWaitDefinition", () => {
  it("start folds the payload and seq into the Context state", () => {
    const match = { event: waitEvent(7, VALID_DATA), role: "start" } as never;
    assert.deepEqual(zaiRetryWaitDefinition.start({} as never, match, {} as never), {
      data: VALID_DATA,
      seq: 7,
    });
  });

  it("start throws on a payload that match would have rejected", () => {
    const match = { event: waitEvent(7, {}), role: "start" } as never;
    assert.throws(() => zaiRetryWaitDefinition.start({} as never, match, {} as never));
  });

  it("update keeps the state unchanged (log-only events never update)", () => {
    const state = { data: VALID_DATA, seq: 7 };
    assert.equal(zaiRetryWaitDefinition.update({ state } as never, {} as never), state);
  });

  it("buildViewNode emits one visible chat node anchored at the event seq", () => {
    const location = { kind: "turn", turn: { index: 1 } };
    const context = {
      key: "k",
      id: "wait-7",
      matches: [],
      start: { event: waitEvent(7, VALID_DATA), role: "start", location },
      state: { data: VALID_DATA, seq: 7 },
      current: new Map(),
    } as never;
    assert.deepEqual(zaiRetryWaitDefinition.buildViewNode?.(context), {
      key: "k",
      kind: "zai-concurrency-retry/wait",
      id: "wait-7",
      target: "chat",
      anchorSeq: 7,
      location,
      visibility: "visible",
      data: VALID_DATA,
    });
  });

  it("buildViewNode returns null without state", () => {
    assert.equal(zaiRetryWaitDefinition.buildViewNode?.({ state: undefined } as never), null);
  });
});
