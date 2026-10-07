import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { RenderClock, startLocalHttpProbe } from "./camoufox";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Synchronous sleep standing in for the blocking flock wait for a restart.
const blockSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

describe("RenderClock", () => {
  it("does not abort while the actual render time stays within the budget", async () => {
    const clock = new RenderClock(500, () => false, () => {});
    await sleep(50);
    assert.equal(clock.signal.aborted, false);
  });

  it("aborts once the actual render time exceeds the budget", async () => {
    const clock = new RenderClock(50, () => false, () => {});
    await sleep(150);
    assert.equal(clock.signal.aborted, true);
  });

  it("does not count restart waits against the render budget", async () => {
    // A restart is in flight for the first two probes (the awaitTurn check and
    // its re-check after waiting); each wait blocks longer than the budget.
    let probes = 0;
    const clock = new RenderClock(
      200,
      () => (probes += 1) <= 2,
      () => blockSync(250),
    );
    clock.awaitTurn(); // pauses, blocks 250ms for the restart, resumes
    await sleep(30);
    assert.equal(clock.signal.aborted, false);
  });
});

describe("startLocalHttpProbe", () => {
  it("serves its url until closed", async () => {
    const probe = await startLocalHttpProbe();
    const response = await fetch(probe.url);
    assert.equal(response.ok, true);
    await probe.close();
    await assert.rejects(() => fetch(probe.url));
  });
});
