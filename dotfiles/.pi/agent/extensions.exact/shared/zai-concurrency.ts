// Z.AI coding-plan concurrency errors (business codes 1302/1305).
//
// Z.AI reports a concurrency rejection as HTTP 429 whose JSON body carries a
// business error code:
//   1302  "Rate limit reached for requests"
//   1305  "The service may be temporarily overloaded, please try again later"
// pi-ai surfaces that body text (sometimes as raw JSON) in the final assistant
// errorMessage, so detection is a wording match on that string.
//
// Shared by the agents extension (which must NOT route these errors into its
// model-fallback/cooldown path — Z.AI concurrency is account-wide, so switching
// models cannot help) and by the zai-concurrency-retry extension (which waits
// and retries them indefinitely).

export const ZAI_PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;

const CONCURRENCY_ERROR_PATTERNS = [
  // Raw JSON body, e.g. {"error":{"code":"1302","message":"Rate limit reached for requests"}}
  /code"\s*:\s*"130[25]"/,
  // Message-only forms (openai SDK APIError text).
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
];

export function isZaiProvider(provider: string | undefined): boolean {
  return provider !== undefined && (ZAI_PROVIDER_IDS as readonly string[]).includes(provider);
}

// Quota codes (1113, 1308-1321) are deliberately NOT matched: they recover only
// at a reset time, so they must keep flowing into the regular rate-limit
// fallback instead of an unbounded retry loop.
export function isZaiConcurrencyLimited(errorMessage: string | undefined): boolean {
  return (
    errorMessage !== undefined &&
    CONCURRENCY_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}

export const RETRY_BASE_DELAY_MS = 5_000;
export const RETRY_MAX_DELAY_MS = 60_000;
const JITTER_RATIO = 0.2;

// Delay before the next retry. A server-provided retryAfterMs wins; otherwise
// exponential growth from RETRY_BASE_DELAY_MS (2^(consecutiveErrors - 1)),
// capped at RETRY_MAX_DELAY_MS, scaled by jitter to de-synchronize parallel
// retriers. consecutiveErrors starts at 1.
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

// Parse a Retry-After header value (delay seconds or an HTTP-date) into ms.
// Returns null when the value is missing or unusable.
export function parseRetryAfterMs(
  value: string | undefined,
  now: number = Date.now(),
): number | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const resetAt = Date.parse(trimmed);
  return Number.isNaN(resetAt) ? null : Math.max(0, resetAt - now);
}
