/**
 * dotfiles-dsh-concurrency-retry — retry provider-specific concurrency
 * failures without an attempt bound.
 *
 * The detector is fail-closed: an active provider route is retried only when
 * its provider rule or the provider-neutral matcher sees explicit concurrency
 * evidence. HTTP 429, RATE_LIMIT, Retry-After, quota, billing, and usage-window
 * facts alone never establish concurrency.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
// Type-only import loads the llm service augmentation for ctx.llm.
import type {} from "@deepseek-ai/dsh-llm";

export const name = "dsh-concurrency-retry";
export const inject = ["llm"];

// ---- session event ------------------------------------------------------------

/** Log-only event type appended once per retry-wait start. */
export const CONCURRENCY_RETRY_WAIT_EVENT_TYPE = "concurrency-retry/wait";

/** Payload of {@link CONCURRENCY_RETRY_WAIT_EVENT_TYPE}: one scheduled wait. */
export interface ConcurrencyRetryWaitData {
  readonly provider: string;
  readonly attempt: number;
  readonly waitMs: number;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "concurrency-retry/wait": ConcurrencyRetryWaitData;
  }
}

// ---- pure logic --------------------------------------------------------------

/** Serializable failure facts used by provider detectors. */
export interface FailureLike {
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly response?: unknown;
  readonly providerRetryAfterMs?: number;
}

const ZAI_CONCURRENCY_CODES = new Set(["1302", "1305"]);
const ZAI_QUOTA_CODES = new Set([
  "1113",
  "1308",
  "1309",
  "1310",
  "1311",
  "1312",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]);

const CODE_FIELD_PATTERN = /["']code["']\s*:\s*["']?([^"'\s,}]+)["']?/gi;
const QUOTA_WORDING_PATTERN =
  /\b(?:quota|billing|balance|credit|insufficient_quota|usage[\s-]*(?:limit|window)|(?:monthly|weekly|daily)\s+limit|resets?)\b/i;
const GENERIC_CONCURRENCY_PATTERN =
  /\b(?:concurrent\s+requests?|concurrency\s+limit|too\s+many\s+concurrent|connection\s+limit\s+reached)\b/i;
const ZAI_MESSAGE_PATTERNS = [
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
] as const;

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response === undefined) return "";
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

function failureText(failure: FailureLike): string {
  return [failure.message, failure.code, responseText(failure.response)].filter(Boolean).join(" ");
}

function responseCodes(failure: FailureLike): Set<string> {
  const codes = new Set<string>();
  if (failure.code !== undefined) codes.add(failure.code);
  for (const match of failureText(failure).matchAll(CODE_FIELD_PATTERN)) codes.add(match[1]);
  return codes;
}

function hasQuotaEvidence(failure: FailureLike): boolean {
  const codes = responseCodes(failure);
  return (
    [...codes].some((code) => ZAI_QUOTA_CODES.has(code)) ||
    QUOTA_WORDING_PATTERN.test(failureText(failure))
  );
}

function isZaiConcurrencyEvidence(failure: FailureLike): boolean {
  const codes = responseCodes(failure);
  if ([...codes].some((code) => ZAI_CONCURRENCY_CODES.has(code))) return true;
  return ZAI_MESSAGE_PATTERNS.some((pattern) => pattern.test(failureText(failure)));
}

function isGenericConcurrencyEvidence(failure: FailureLike): boolean {
  return GENERIC_CONCURRENCY_PATTERN.test(failureText(failure));
}

type FailureDetector = (failure: FailureLike) => boolean;

/** Provider rules contain only evidence confirmed for that provider's adapter. */
const PROVIDER_DETECTORS = new Map<string, FailureDetector>([
  ["zai", isZaiConcurrencyEvidence],
  ["zai-coding-cn", isZaiConcurrencyEvidence],
]);

/**
 * True only for a registered provider route with dedicated concurrency
 * evidence. The active-route check belongs to apply(), while this pure
 * function makes detector and precedence behavior directly testable.
 */
export function isConcurrencyFailure(provider: string, failure: FailureLike): boolean {
  if (hasQuotaEvidence(failure)) return false;
  return (PROVIDER_DETECTORS.get(provider) ?? isGenericConcurrencyEvidence)(failure);
}

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 60_000;
const JITTER_RATIO = 0.2;

/** A positive finite provider-requested delay, otherwise no override. */
export function retryAfterOverrideMs(failure: FailureLike): number | null {
  const requested = failure.providerRetryAfterMs;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : null;
}

/** Delay before the next retry, preserving the existing exponential backoff. */
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

/** One agent's retry-chain bookkeeping. */
export interface RetryChain {
  consecutive: number;
  turn: number;
  step: number;
}

export function nextConsecutiveCount(
  previous: RetryChain | undefined,
  turn: number,
  step: number,
): number {
  if (previous && previous.turn === turn && previous.step === step) return previous.consecutive + 1;
  return 1;
}

// ---- glue --------------------------------------------------------------------

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
  const logger = ctx.logger("dsh-concurrency-retry");
  const chains = new WeakMap<Agent, RetryChain>();
  let activeRoutes = new Set(ctx.llm.listProviders().map(({ id }) => id));

  ctx.on("llm/adapters-updated", () => {
    activeRoutes = new Set(ctx.llm.listProviders().map(({ id }) => id));
  });

  ctx.on(
    "agent/request-error",
    async (payload, next) => {
      if (
        !activeRoutes.has(payload.provider) ||
        !isConcurrencyFailure(payload.provider, payload.failure)
      ) {
        return next();
      }
      const previous = chains.get(payload.agent);
      const consecutive = nextConsecutiveCount(previous, payload.turn, payload.step);
      chains.set(payload.agent, { consecutive, turn: payload.turn, step: payload.step });
      const delayMs = nextRetryDelayMs(consecutive, retryAfterOverrideMs(payload.failure));
      logger.warn(
        `${payload.provider} concurrency limit (attempt ${consecutive}); ` +
          `retrying the same step in ${Math.ceil(delayMs / 1000)}s: ${payload.failure.message}`,
      );
      queueMicrotask(() => {
        try {
          payload.agent.session.append(CONCURRENCY_RETRY_WAIT_EVENT_TYPE, {
            provider: payload.provider,
            attempt: consecutive,
            waitMs: delayMs,
          });
        } catch (error) {
          logger.warn(`failed to append ${CONCURRENCY_RETRY_WAIT_EVENT_TYPE}: ${String(error)}`);
        }
      });
      if (!(await cancellableDelay(delayMs, payload.signal))) return;
      return { kind: "retry" };
    },
    { prepend: true },
  );
}
