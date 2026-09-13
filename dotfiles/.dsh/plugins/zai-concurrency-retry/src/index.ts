/**
 * dotfiles-dsh-zai-concurrency-retry — host-side port of the pi
 * `zai-concurrency-retry` extension.
 *
 * Z.AI coding plans reject concurrent requests with business codes 1302 /
 * 1305. The rejection arrives as an HTTP 429 whose body text surfaces in the
 * LLM failure message; the numbers never appear in the stable failure `code`
 * (dsh-llm-pi-ai classifies them as plain `RATE_LIMIT`, same as quota
 * errors). The limit is account-wide, so switching models cannot recover it.
 * This plugin detects those failures, waits out an exponential backoff, and
 * retries the same step without a retry-count bound:
 *
 *   detection  provider `zai` / `zai-coding-cn` plus message patterns
 *              (quota codes 1113 / 1308-1321 are deliberately excluded and
 *              keep flowing to the regular rate-limit fallback)
 *   backoff    5s × 2^(n-1) capped at 60s, ±20% symmetric jitter, where n is
 *              the consecutive failure count of the current retry chain
 *   ownership  the `agent/request-error` waterfall, joined with
 *              `prepend: true` so this listener runs outermost, before
 *              dsh-llm-retry's budgeted retry and dsh-agents' model
 *              fallback; everything else falls through `next()` untouched
 *   display    one `zai-concurrency-retry/wait` session event per wait
 *              start (durable, so reloads re-render it), folded into a
 *              one-line transcript row by the client bundle in `src/client/`
 *
 * `run_build.sh` bundles entries: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external (see the
 * skill-status README "Build"). Pure logic is exported below and tested
 * in `src/index.test.ts`; runtime imports are types only.
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only import also pulls in the `declare module '@deepseek-ai/cordis'`
// event augmentations (typed `ctx.on('agent/request-error', ...)`).
import type { Agent } from "@deepseek-ai/dsh-agent";

export const name = "dsh-zai-concurrency-retry";

// ---- session event ------------------------------------------------------------

/** Log-only event type appended once per retry-wait start. */
export const ZAI_RETRY_WAIT_EVENT_TYPE = "zai-concurrency-retry/wait";

/** Payload of {@link ZAI_RETRY_WAIT_EVENT_TYPE}: one scheduled wait. */
export interface ZaiRetryWaitData {
  readonly provider: string;
  readonly attempt: number;
  readonly waitMs: number;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "zai-concurrency-retry/wait": ZaiRetryWaitData;
  }
}

// ---- pure logic ------------------------------------------------------------

/** Z.AI provider ids. pi parity (`shared/zai-concurrency.ts`): model-sync
 * registers both; the dsh deployment routes `zai` today. */
const ZAI_PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;

const CONCURRENCY_ERROR_PATTERNS = [
  // Raw JSON body, e.g. {"error":{"code":"1302","message":"Rate limit reached for requests"}}
  /code"\s*:\s*"130[25]"/,
  // Message-only forms (openai SDK APIError text).
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
] as const;

/** Serializable failure facts (subset of dsh-llm `LlmFailure`). */
export interface FailureLike {
  readonly message: string;
  readonly providerRetryAfterMs?: number;
}

// True for a Z.AI concurrency failure (1302 "Rate limit reached for
// requests" / 1305 "temporarily overloaded"). Quota codes (1113, 1308-1321)
// are deliberately NOT matched: they recover only at a reset time, so they
// must keep flowing to the regular rate-limit fallback instead of this
// unbounded same-step loop.
export function isZaiConcurrencyFailure(provider: string, failure: FailureLike): boolean {
  return (
    (ZAI_PROVIDER_IDS as readonly string[]).includes(provider) &&
    CONCURRENCY_ERROR_PATTERNS.some((pattern) => pattern.test(failure.message))
  );
}

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 60_000;
const JITTER_RATIO = 0.2;

// A positive finite provider-requested delay (dsh-llm-retry's validity rule).
// dsh-llm-pi-ai never sets `providerRetryAfterMs` today, so the local
// backoff below is the live path; the override keeps this plugin correct if
// an adapter starts carrying Retry-After.
export function retryAfterOverrideMs(failure: FailureLike): number | null {
  const requested = failure.providerRetryAfterMs;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : null;
}

// Delay before the next retry (the pi formula): a provider retry-after wins
// verbatim; otherwise 5s × 2^(consecutiveErrors - 1) capped at 60s, scaled by
// ±20% symmetric jitter to de-synchronize parallel retriers. consecutiveErrors
// starts at 1.
export function nextRetryDelayMs(
  consecutiveErrors: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (consecutiveErrors - 1);
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  return Math.round(capped * (1 - JITTER_RATIO + random() * 2 * JITTER_RATIO));
}

/** One agent's retry-chain bookkeeping. Same turn+step means one in-step
 * retry loop; anything else starts a new chain. */
export interface RetryChain {
  consecutive: number;
  turn: number;
  step: number;
}

// The agent loop retries a failed request inside the same turn+step
// (`step/start` is not re-appended on retry), so a matching turn+step grows
// the count and any other turn/step restarts at 1. This gives dsh-llm-retry's
// reset timing (its projection clears on `step/start` / `turn/end`) without
// durable state — pi's counter was in-memory too.
export function nextConsecutiveCount(
  previous: RetryChain | undefined,
  turn: number,
  step: number,
): number {
  if (previous && previous.turn === turn && previous.step === step) return previous.consecutive + 1;
  return 1;
}

// ---- glue --------------------------------------------------------------------

/** Resolve when ms have elapsed; false means the signal aborted the wait. */
function cancellableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function apply(ctx: Context): void {
  const logger = ctx.logger("dsh-zai-concurrency-retry");
  // Per-agent chains; a WeakMap needs no agent/disposed cleanup.
  const chains = new WeakMap<Agent, RetryChain>();

  // `prepend: true` puts this listener at the front of the hook list
  // regardless of plugin load order (activation is service-availability
  // driven, not bundle order), so Z.AI concurrency errors never reach
  // dsh-llm-retry's short-budget retry or dsh-agents' model fallback.
  ctx.on(
    "agent/request-error",
    async (payload, next) => {
      if (!isZaiConcurrencyFailure(payload.provider, payload.failure)) return next();
      const previous = chains.get(payload.agent);
      const consecutive = nextConsecutiveCount(previous, payload.turn, payload.step);
      chains.set(payload.agent, { consecutive, turn: payload.turn, step: payload.step });
      const delayMs = nextRetryDelayMs(consecutive, retryAfterOverrideMs(payload.failure));
      logger.warn(
        `Z.AI concurrency limit on ${payload.provider} (attempt ${consecutive}); ` +
          `retrying the same step in ${Math.ceil(delayMs / 1000)}s: ${payload.failure.message}`,
      );
      // Deferred to a microtask like dsh-skill-status's append: session.append
      // must stay out of any open event publication window. The event is the
      // transport for the transcript row the client bundle renders.
      queueMicrotask(() => {
        try {
          payload.agent.session.append(ZAI_RETRY_WAIT_EVENT_TYPE, {
            provider: payload.provider,
            attempt: consecutive,
            waitMs: delayMs,
          });
        } catch (error) {
          logger.warn(`failed to append ${ZAI_RETRY_WAIT_EVENT_TYPE}: ${String(error)}`);
        }
      });
      // Aborted mid-wait: leave the failure terminal — the user asked to stop.
      if (!(await cancellableDelay(delayMs, payload.signal))) return;
      return { kind: "retry" };
    },
    { prepend: true },
  );
}
