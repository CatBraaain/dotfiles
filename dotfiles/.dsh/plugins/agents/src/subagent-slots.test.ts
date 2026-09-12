import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { SubagentSlots } from "./subagent-slots.ts";

function tick(): Promise<void> {
  return Promise.resolve();
}

describe("SubagentSlots", () => {
  it("allows up to the limit concurrently", async () => {
    const slots = new SubagentSlots(2);
    const r1 = await slots.acquire();
    const r2 = await slots.acquire();
    assert.equal(slots.waiting, 0);
    r1();
    r2();
  });

  it("queues a third caller and releases it FIFO", async () => {
    const slots = new SubagentSlots(2);
    const r1 = await slots.acquire();
    const r2 = await slots.acquire();
    let released3 = false;
    const third = slots.acquire().then((release) => {
      released3 = true;
      return release;
    });
    await tick();
    assert.equal(released3, false);
    assert.equal(slots.waiting, 1);

    r1(); // first release admits the queued caller
    const r3 = await third;
    assert.equal(released3, true);
    assert.equal(slots.waiting, 0);
    r2();
    r3();
  });

  it("ignores double release", async () => {
    const slots = new SubagentSlots(1);
    const release = await slots.acquire();
    release();
    release(); // must not over-decrement
    const next = await slots.acquire();
    next();
  });

  it("rejects a queued caller when its signal aborts", async () => {
    const slots = new SubagentSlots(1);
    const r1 = await slots.acquire();
    const controller = new AbortController();
    const queued = slots.acquire(controller.signal);
    await tick();
    assert.equal(slots.waiting, 1);
    controller.abort();
    await assert.rejects(queued, /cancelled while waiting/);
    assert.equal(slots.waiting, 0);

    // The abandoned caller did not leak a slot: the next caller is granted
    // only when the active one releases.
    let granted = false;
    const next = slots.acquire().then((release) => {
      granted = true;
      return release;
    });
    await tick();
    assert.equal(granted, false);
    r1();
    const release = await next;
    release();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const slots = new SubagentSlots(1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(slots.acquire(controller.signal), /cancelled while waiting/);
  });

  it("rejects an invalid limit", () => {
    assert.throws(() => new SubagentSlots(0));
    assert.throws(() => new SubagentSlots(1.5));
  });
});
