import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COOLDOWN_MS,
  cooldownMs,
  createPredictionCache,
  isCoolingDown,
  isRateLimitFailure,
  modelKey,
  pickCandidate,
  recordCooldown,
  snapshotRoutingState,
} from "./routing.ts";
import type { ModelCandidate } from "./config.ts";

const always = async () => true;
const never = async () => false;

function candidates(): ModelCandidate[] {
  return [
    { provider: "p1", model: "m1" },
    { provider: "p2", model: "m2" },
    { provider: "p3", model: "m3" },
  ];
}

describe("isRateLimitFailure", () => {
  it("treats HTTP 429 as a rate limit", () => {
    assert.equal(isRateLimitFailure({ message: "x", code: "OTHER", status: 429 }), true);
  });

  it("matches RATE_LIMIT and QUOTA codes regardless of status", () => {
    assert.equal(isRateLimitFailure({ message: "x", code: "RATE_LIMIT" }), true);
    assert.equal(isRateLimitFailure({ message: "x", code: "QUOTA" }), true);
    assert.equal(isRateLimitFailure({ message: "x", code: "AUTH" }), false);
    assert.equal(isRateLimitFailure({ message: "rate limit", code: "OTHER", status: 500 }), false);
  });
});

describe("cooldownMs", () => {
  it("prefers a positive providerRetryAfterMs and falls back to the default", () => {
    assert.equal(
      cooldownMs({ message: "x", code: "RATE_LIMIT", providerRetryAfterMs: 5000 }),
      5000,
    );
    assert.equal(
      cooldownMs({ message: "x", code: "RATE_LIMIT", providerRetryAfterMs: -1 }),
      DEFAULT_COOLDOWN_MS,
    );
    assert.equal(cooldownMs({ message: "x", code: "RATE_LIMIT" }), DEFAULT_COOLDOWN_MS);
  });
});

describe("snapshotRoutingState", () => {
  it("copies mutable routing state before asynchronous prediction", () => {
    const cooldowns = new Map([["p/m", 1000]]);
    const state = {
      effectiveClass: "middle",
      cooldowns,
      cooldownEpoch: 2,
      manualSelect: false,
      lastRoute: { provider: "p", model: "m" },
    };
    const snapshot = snapshotRoutingState(state);

    state.effectiveClass = "high";
    state.cooldowns.set("p/other", 2000);
    state.lastRoute = { provider: "q", model: "n" };

    assert.deepEqual(snapshot, {
      effectiveClass: "middle",
      cooldowns: new Map([["p/m", 1000]]),
      cooldownEpoch: 2,
      manualSelect: false,
      lastRoute: { provider: "p", model: "m" },
    });
  });
});

describe("cooldown bookkeeping", () => {
  it("expires stale entries on read", () => {
    const cooldowns = new Map<string, number>();
    recordCooldown(cooldowns, "p/m", 1000, 0);
    assert.equal(isCoolingDown("p/m", cooldowns, 500), true);
    assert.equal(isCoolingDown("p/m", cooldowns, 1000), false);
    assert.equal(cooldowns.has("p/m"), false);
  });

  it("keys routes by provider/model", () => {
    assert.equal(modelKey({ provider: "zai", model: "glm" }), "zai/glm");
  });
});

describe("pickCandidate", () => {
  it("returns the first live candidate", async () => {
    const picked = await pickCandidate(candidates(), new Map(), always, always, 0);
    assert.deepEqual(picked, { provider: "p1", model: "m1" });
  });

  it("skips candidates missing from the registry", async () => {
    const exists = async (c: ModelCandidate) => c.provider !== "p1";
    const picked = await pickCandidate(candidates(), new Map(), exists, always, 0);
    assert.deepEqual(picked, { provider: "p2", model: "m2" });
  });

  it("skips cooling-down candidates", async () => {
    const cooldowns = new Map<string, number>();
    recordCooldown(cooldowns, "p1/m1", 10_000, 0);
    const picked = await pickCandidate(candidates(), cooldowns, always, always, 1000);
    assert.deepEqual(picked, { provider: "p2", model: "m2" });
  });

  it("skips candidates whose when fails and returns null when all fail", async () => {
    const withWhen: ModelCandidate[] = [
      { provider: "p1", model: "m1", when: "false-check" },
      { provider: "p2", model: "m2" },
    ];
    const evalWhen = async (when: string | undefined) => when === undefined;
    const picked = await pickCandidate(withWhen, new Map(), always, evalWhen, 0);
    assert.deepEqual(picked, { provider: "p2", model: "m2" });

    const none = await pickCandidate(candidates(), new Map(), always, never, 0);
    assert.equal(none, null);
  });

  it("checks route, cooldown, then when before selecting a fallback", async () => {
    const calls: string[] = [];
    const candidatesWithFallback: ModelCandidate[] = [
      { provider: "p1", model: "missing", when: "not-called-1" },
      { provider: "p2", model: "cooling", when: "not-called-2" },
      { provider: "p3", model: "fallback", when: "eligible" },
    ];
    const cooldowns = new Map<string, number>();
    recordCooldown(cooldowns, "p2/cooling", 10_000, 0);
    const picked = await pickCandidate(
      candidatesWithFallback,
      cooldowns,
      async (candidate) => {
        calls.push(`exists:${candidate.model}`);
        return candidate.model !== "missing";
      },
      async (when) => {
        calls.push(`when:${when}`);
        return true;
      },
      1000,
    );

    assert.deepEqual(picked, { provider: "p3", model: "fallback", when: "eligible" });
    assert.deepEqual(calls, [
      "exists:missing",
      "exists:cooling",
      "exists:fallback",
      "when:eligible",
    ]);
  });
});

describe("createPredictionCache", () => {
  it("reuses the first answer for the same key within the TTL", async () => {
    let clock = 0;
    let runs = 0;
    const cache = createPredictionCache(10_000, () => clock);
    const run = async (): Promise<string | undefined> => {
      runs++;
      return "m1";
    };
    assert.equal(await cache.read("k", run), "m1");
    clock = 5_000;
    assert.equal(await cache.read("k", run), "m1");
    assert.equal(runs, 1);
  });

  it("re-runs after the TTL window passed", async () => {
    let clock = 0;
    let runs = 0;
    const cache = createPredictionCache(10_000, () => clock);
    const run = async (): Promise<string | undefined> => {
      runs++;
      return `m${runs}`;
    };
    assert.equal(await cache.read("k", run), "m1");
    clock = 10_000;
    assert.equal(await cache.read("k", run), "m2");
  });

  it("treats a new key as a fresh prediction immediately", async () => {
    let clock = 0;
    const cache = createPredictionCache(10_000, () => clock);
    assert.equal(await cache.read("a", async () => "m1"), "m1");
    assert.equal(await cache.read("b", async () => "m2"), "m2");
  });

  it("caches undefined answers within the TTL", async () => {
    let clock = 0;
    let runs = 0;
    const cache = createPredictionCache(10_000, () => clock);
    const run = async (): Promise<string | undefined> => {
      runs++;
      return undefined;
    };
    assert.equal(await cache.read("k", run), undefined);
    clock = 5_000;
    assert.equal(await cache.read("k", run), undefined);
    assert.equal(runs, 1);
  });
});
