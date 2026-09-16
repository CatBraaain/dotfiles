import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { concurrencyRetryWaitDefinition, waitEventData } from "./conversation";
import { CONCURRENCY_RETRY_WAIT_EVENT_TYPE } from "./event";

const VALID_DATA = { provider: "catalog-provider", attempt: 2, waitMs: 30_000 };

function waitEvent(seq: number, data: unknown) {
  return {
    type: CONCURRENCY_RETRY_WAIT_EVENT_TYPE,
    seq,
    time: 0,
    data,
  } as Parameters<typeof concurrencyRetryWaitDefinition.match>[0];
}

describe("waitEventData", () => {
  it("passes a valid provider payload through", () => {
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

describe("concurrencyRetryWaitDefinition.match", () => {
  it("accepts a wait event as a start keyed by seq", () => {
    assert.deepEqual(concurrencyRetryWaitDefinition.match(waitEvent(7, VALID_DATA)), {
      id: "wait-7",
      role: "start",
    });
  });

  it("rejects other event types and malformed payloads", () => {
    assert.equal(
      concurrencyRetryWaitDefinition.match({
        ...waitEvent(7, VALID_DATA),
        type: "llm/retry",
      } as never),
      null,
    );
    assert.equal(
      concurrencyRetryWaitDefinition.match(waitEvent(7, { provider: "catalog-provider" })),
      null,
    );
  });
});

describe("concurrencyRetryWaitDefinition", () => {
  it("start folds the payload and seq into the Context state", () => {
    const match = { event: waitEvent(7, VALID_DATA), role: "start" } as never;
    assert.deepEqual(concurrencyRetryWaitDefinition.start({} as never, match, {} as never), {
      data: VALID_DATA,
      seq: 7,
    });
  });

  it("start throws on a payload that match would have rejected", () => {
    const match = { event: waitEvent(7, {}), role: "start" } as never;
    assert.throws(() => concurrencyRetryWaitDefinition.start({} as never, match, {} as never));
  });

  it("update keeps the state unchanged", () => {
    const state = { data: VALID_DATA, seq: 7 };
    assert.equal(concurrencyRetryWaitDefinition.update({ state } as never, {} as never), state);
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
    assert.deepEqual(concurrencyRetryWaitDefinition.buildViewNode?.(context), {
      key: "k",
      kind: "concurrency-retry/wait",
      id: "wait-7",
      target: "chat",
      anchorSeq: 7,
      location,
      visibility: "visible",
      data: VALID_DATA,
    });
  });

  it("buildViewNode returns null without state", () => {
    assert.equal(
      concurrencyRetryWaitDefinition.buildViewNode?.({ state: undefined } as never),
      null,
    );
  });
});
