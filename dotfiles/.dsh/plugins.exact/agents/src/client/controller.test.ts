import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { AGENTS_STATE_PATH } from "../state-rpc";
import { createStateReader, startStatePoller, type StatePollerDeps } from "./controller";
import type { AgentDisplayState } from "./format";
import { createSelectSender, createStateFetcher } from "./state";

/** Timer handles captured by the stub clock. */
interface StubClock {
  readonly setIntervalCalls: number;
  readonly clearIntervalCalls: number;
  /** Fire the registered interval callback once. */
  tick: () => void;
}

/** Injectable clock recording registrations; ticks only on demand. */
function createStubClock(): StubClock & Pick<StatePollerDeps, "setInterval" | "clearInterval"> {
  let callback: (() => void) | undefined;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;
  return {
    get setIntervalCalls() {
      return setIntervalCalls;
    },
    get clearIntervalCalls() {
      return clearIntervalCalls;
    },
    setInterval(callback_: () => void, _intervalMs: number): unknown {
      setIntervalCalls += 1;
      callback = callback_;
      return setIntervalCalls;
    },
    clearInterval(_handle: unknown): void {
      clearIntervalCalls += 1;
    },
    tick(): void {
      callback?.();
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createStateReader", () => {
  it("ignores an older response after a newer refresh starts", async () => {
    const first = deferred<AgentDisplayState>();
    const second = deferred<AgentDisplayState>();
    const seen: AgentDisplayState[] = [];
    const reader = createStateReader(
      (() => {
        const requests = [first.promise, second.promise];
        return () => requests.shift()!;
      })(),
      (state) => seen.push(state),
    );

    const firstRefresh = reader.refresh();
    const secondRefresh = reader.refresh();
    second.resolve({ managed: true, agent: "main", className: "high", model: "m-high" });
    await secondRefresh;
    first.resolve({ managed: true, agent: "main", className: "middle", model: "m-middle" });
    await firstRefresh;

    assert.deepEqual(seen, [{ managed: true, agent: "main", className: "high", model: "m-high" }]);
  });

  it("keeps component state when an accepted pick's immediate refresh fails", async () => {
    const sessionId = "session-1" as SessionId;
    const initialState = {
      managed: true,
      agent: "main",
      className: "high",
      agents: ["main"],
      classes: ["high", "low"],
    } satisfies AgentDisplayState;
    let stateRequests = 0;
    const doFetch = async (input: string | URL | Request): Promise<Response> => {
      if (input === AGENTS_STATE_PATH) {
        stateRequests += 1;
        if (stateRequests > 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ ...initialState, manual: false }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, text: "class → low" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const fetchState = createStateFetcher(doFetch);
    const select = createSelectSender(doFetch);
    const seen: AgentDisplayState[] = [];
    const reader = createStateReader(() => fetchState(sessionId), (state) => seen.push(state));

    await reader.refresh();
    assert.deepEqual(await select(sessionId, "class", "low"), { ok: true });
    await reader.refresh();

    assert.deepEqual(seen, [initialState]);
  });
});

describe("startStatePoller", () => {
  it("fetches once immediately, then on every interval tick", async () => {
    const seen: AgentDisplayState[] = [];
    const clock = createStubClock();
    let fetches = 0;
    startStatePoller(2000, {
      fetchState: async () => {
        fetches += 1;
        return { managed: true, agent: "main", className: "middle" };
      },
      onState: (state) => seen.push(state),
      ...clock,
    });
    await Promise.resolve();
    clock.tick();
    await Promise.resolve();

    assert.equal(fetches, 2);
    assert.equal(clock.setIntervalCalls, 1);
    assert.deepEqual(seen, [
      { managed: true, agent: "main", className: "middle" },
      { managed: true, agent: "main", className: "middle" },
    ]);
  });

  it("keeps the last known state when a fetch fails", async () => {
    const seen: AgentDisplayState[] = [];
    const clock = createStubClock();
    let fail = false;
    const poller = startStatePoller(2000, {
      fetchState: async () => {
        if (fail) throw new Error("disconnected");
        return { managed: true, agent: "main", className: "middle" };
      },
      onState: (state) => seen.push(state),
      ...clock,
    });
    await Promise.resolve();
    assert.equal(seen.length, 1);

    fail = true;
    clock.tick();
    await Promise.resolve();
    assert.equal(seen.length, 1);

    fail = false;
    clock.tick();
    await Promise.resolve();
    assert.equal(seen.length, 2);
    poller();
  });

  it("stops fetching and clears the interval after the stop function runs", async () => {
    const clock = createStubClock();
    let fetches = 0;
    const poller = startStatePoller(2000, {
      fetchState: async () => {
        fetches += 1;
        return { managed: false };
      },
      onState: () => {},
      ...clock,
    });
    await Promise.resolve();
    assert.equal(fetches, 1);

    poller();
    clock.tick();
    await Promise.resolve();
    assert.equal(fetches, 1);
    assert.equal(clock.clearIntervalCalls, 1);
  });
});
