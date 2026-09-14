// routing — class-candidate selection, cooldown bookkeeping, and rate-limit
// failure classification. Pure logic with injected model lookups and `when`
// evaluation so tests need neither dsh services nor a shell. The glue injects
// `ctx.llm.resolveModelInfo` for registry checks and the dsh shell contract
// for `when` commands.

import type { ModelCandidate } from "./config.ts";

/** Default cooldown once a rate-limited route leaves the rotation. */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** `when` commands must settle within this budget or the candidate is dead. */
export const WHEN_TIMEOUT_MS = 5_000;

/** Serializable provider/transport failure facts (subset of dsh-llm LlmFailure). */
export interface FailureLike {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
}

// Rate limit detection rides the stable provider-neutral failure facts: the
// HTTP status and the machine-routing `code` (`RATE_LIMIT`, `QUOTA`). Unlike
// the pi extension there is no message-pattern fallback — dsh adapters
// normalize failures at the final boundary so the code is authoritative.
export function isRateLimitFailure(failure: FailureLike): boolean {
  if (failure.status === 429) return true;
  return failure.code === "RATE_LIMIT" || failure.code === "QUOTA";
}

// Cooldown duration for a rate-limited failure: the provider's requested
// delay when present, otherwise the default.
export function cooldownMs(failure: FailureLike): number {
  const requested = failure.providerRetryAfterMs;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : DEFAULT_COOLDOWN_MS;
}

export function modelKey(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`;
}

export interface RoutingStateLike {
  readonly effectiveClass: string;
  readonly cooldowns: ReadonlyMap<string, number>;
  readonly cooldownEpoch: number;
  readonly manualSelect: boolean;
  readonly lastRoute: { provider: string; model: string } | undefined;
}

export interface RoutingStateSnapshot {
  readonly effectiveClass: string;
  readonly cooldowns: Map<string, number>;
  readonly cooldownEpoch: number;
  readonly manualSelect: boolean;
  readonly lastRoute: { provider: string; model: string } | undefined;
}

export function snapshotRoutingState(state: RoutingStateLike): RoutingStateSnapshot {
  return {
    effectiveClass: state.effectiveClass,
    cooldowns: new Map(state.cooldowns),
    cooldownEpoch: state.cooldownEpoch,
    manualSelect: state.manualSelect,
    lastRoute: state.lastRoute === undefined ? undefined : { ...state.lastRoute },
  };
}

// True if `key` is still cooling down at `now`. Lazily evicts expired entries
// so a stale cooldown never silently blocks a model forever.
export function isCoolingDown(key: string, cooldowns: Map<string, number>, now: number): boolean {
  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now >= expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

// Put `key` in the rate-limit doghouse until now + ms.
export function recordCooldown(
  cooldowns: Map<string, number>,
  key: string,
  ms: number,
  now: number,
): void {
  cooldowns.set(key, now + ms);
}

/**
 * TTL cache for predicted display models. The browser display poll re-derives
 * the next-request resolution far more often than routing itself runs, and a
 * prediction re-runs the `when` commands and registry lookups; within the TTL
 * window a repeated key reuses the first answer. Callers fold the state that
 * may change (session, class, cooldown generation) into the key so a change
 * predicts fresh immediately. `now` is injectable for tests.
 */
export interface PredictionCache {
  read(key: string, run: () => Promise<string | undefined>): Promise<string | undefined>;
}

export function createPredictionCache(
  ttlMs: number,
  now: () => number = Date.now,
): PredictionCache {
  const entries = new Map<string, { at: number; value: Promise<string | undefined> }>();
  return {
    read(key, run) {
      const at = now();
      const cached = entries.get(key);
      if (cached && at - cached.at < ttlMs) return cached.value;
      const value = run();
      entries.set(key, { at, value });
      // Opportunistic eviction so a long-lived process cannot accumulate one
      // dead key per class/cooldown generation.
      if (entries.size > 64) {
        for (const [staleKey, stale] of entries) {
          if (at - stale.at >= ttlMs) entries.delete(staleKey);
        }
      }
      return value;
    },
  };
}

// The first candidate (top-to-bottom) whose model exists in the registry, is
// not cooling down, and whose `when` passes. Registry existence and `when`
// evaluation are injected so this stays testable without dsh services.
export async function pickCandidate(
  candidates: readonly ModelCandidate[],
  cooldowns: Map<string, number>,
  modelExists: (candidate: ModelCandidate) => Promise<boolean>,
  evalWhen: (when: string | undefined) => Promise<boolean>,
  now: number,
): Promise<ModelCandidate | null> {
  for (const candidate of candidates) {
    if (!(await modelExists(candidate))) continue;
    if (isCoolingDown(modelKey(candidate), cooldowns, now)) continue;
    if (!(await evalWhen(candidate.when))) continue;
    return candidate;
  }
  return null;
}
