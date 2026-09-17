/**
 * Unbounded wait-and-retry for provider concurrency errors.
 *
 * pi's built-in agent retry already retries these errors, but its budget is
 * finite (settings.retry.maxRetries) and its backoff starts near zero, so
 * concurrent runs keep hammering the provider until every session fails. This
 * extension makes the retry loop unbounded and paced:
 *
 *   turn path    — message_end waits out the backoff, then rewrites the error
 *                  into a retryable message so pi's agent retry replays it.
 *                  Budget-limited (typically settings.retry.maxRetries tries).
 *   settled path — once the turn has fully settled on a concurrency error,
 *                  wait, then re-trigger the turn via pi.sendMessage. This
 *                  resets pi's retry budget, making the overall loop unbounded.
 *
 * Detection is fail-closed, mirroring the dsh concurrency-retry plugin: an
 * error is retried only on explicit concurrency evidence — provider-specific
 * evidence for zai / zai-coding-cn (codes 1302/1305) or generic concurrency
 * wording for any other provider. Quota/billing/usage-window evidence is
 * always excluded first. HTTP 429 on non-Z.AI providers is still handled by
 * the agents extension's immediate fallback; this extension only reacts to
 * the assistant error text.
 * 詳細は ./SPEC.md。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export const RETRY_MESSAGE_PREFIX = "provider returned error: ";
const RETRY_TRIGGER_CONTENT =
  "The previous request failed with a temporary provider concurrency limit. Continue the interrupted task.";
const STATUS_KEY = "concurrency-retry";

// ---- detection (fail-closed) -------------------------------------------------

const ZAI_CONCURRENCY_CODES = new Set(["1302", "1305"]);
// Quota codes are deliberately NOT matched: they recover only at a reset time,
// so they must keep flowing into the agents extension's rate-limit fallback
// instead of an unbounded retry loop.
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

// Extracts the value of a "code" field from a raw JSON body embedded in the
// error text, e.g. {"error":{"code":"1302","message":"..."}}.
const CODE_FIELD_PATTERN = /["']code["']\s*:\s*["']?([^"'\s,}]+)["']?/gi;
const QUOTA_WORDING_PATTERN =
  /\b(?:quota|billing|balance|credit|insufficient_quota|usage[\s-]*(?:limit|window)|(?:monthly|weekly|daily)\s+limit|resets?)\b/i;
const GENERIC_CONCURRENCY_PATTERN =
  /\b(?:concurrent\s+requests?|concurrency\s+limit|too\s+many\s+concurrent|connection\s+limit\s+reached)\b/i;
const ZAI_MESSAGE_PATTERNS = [
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
] as const;

function extractCodes(errorMessage: string): Set<string> {
  const codes = new Set<string>();
  for (const match of errorMessage.matchAll(CODE_FIELD_PATTERN)) {
    if (match[1] !== undefined) codes.add(match[1]);
  }
  return codes;
}

function hasQuotaEvidence(errorMessage: string, codes: Set<string>): boolean {
  return (
    [...codes].some((code) => ZAI_QUOTA_CODES.has(code)) ||
    QUOTA_WORDING_PATTERN.test(errorMessage)
  );
}

function isZaiConcurrencyEvidence(codes: Set<string>, errorMessage: string): boolean {
  if ([...codes].some((code) => ZAI_CONCURRENCY_CODES.has(code))) return true;
  return ZAI_MESSAGE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

function isGenericConcurrencyEvidence(errorMessage: string): boolean {
  return GENERIC_CONCURRENCY_PATTERN.test(errorMessage);
}

type ConcurrencyDetector = (codes: Set<string>, errorMessage: string) => boolean;

/** Provider rules contain only evidence confirmed for that provider's adapter. */
const PROVIDER_DETECTORS = new Map<string, ConcurrencyDetector>([
  ["zai", isZaiConcurrencyEvidence],
  ["zai-coding-cn", isZaiConcurrencyEvidence],
]);

/**
 * True only on explicit concurrency evidence. Quota/billing evidence wins
 * first; a provider with a dedicated rule never falls through to the generic
 * matcher, so wording-specific guarantees stay per-provider.
 */
export function isConcurrencyError(
  provider: string,
  errorMessage: string | undefined,
): boolean {
  if (errorMessage === undefined || errorMessage === "") return false;
  const codes = extractCodes(errorMessage);
  if (hasQuotaEvidence(errorMessage, codes)) return false;
  const detector = PROVIDER_DETECTORS.get(provider);
  if (detector) return detector(codes, errorMessage);
  return isGenericConcurrencyEvidence(errorMessage);
}

// ---- backoff -----------------------------------------------------------------

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

// ---- retry loop ---------------------------------------------------------------

let consecutiveConcurrencyErrors = 0;
let lastRetryAfterMs: number | null = null;
let settledRetryProvider: string | null = null;

/** Replace the error text with a form pi's built-in retry treats as retryable. */
export function makeRetryableMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, errorMessage: `${RETRY_MESSAGE_PREFIX}${message.errorMessage ?? ""}` };
}

function takeRetryAfter(): number | null {
  const value = lastRetryAfterMs;
  lastRetryAfterMs = null;
  return value;
}

/** Resolve when ms have elapsed; false means the signal aborted the wait. */
export function realSleepMs(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Test seams: swap out real time waiting and randomness. Same pattern as the
// agents extension's __spawn.
export const __sleep: {
  current: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>;
} = { current: realSleepMs };
export const __random: { current: () => number } = { current: Math.random };

export default function concurrencyRetryExtension(pi: ExtensionAPI): void {
  // Remember the provider's Retry-After so the message_end wait can honor it.
  // pi's agent retry is errorMessage-based and drops headers, so this hook is
  // the only place they are observable. Any provider's 429 counts; the value
  // is consumed once by the next concurrency wait.
  pi.on("after_provider_response", (event) => {
    if (event.status !== 429) return;
    lastRetryAfterMs = parseRetryAfterMs(event.headers["retry-after"]);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as Message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") {
      consecutiveConcurrencyErrors = 0;
      return;
    }
    if (!isConcurrencyError(message.provider, message.errorMessage)) return;

    consecutiveConcurrencyErrors += 1;
    const delayMs = nextRetryDelayMs(
      consecutiveConcurrencyErrors,
      takeRetryAfter(),
      __random.current,
    );

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `${message.provider} concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
      );
    }
    const waitCompleted = await __sleep.current(delayMs, ctx.signal);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    // Aborted mid-wait: let the turn end with the original error, the user
    // asked to stop.
    if (!waitCompleted) return;
    return { message: makeRetryableMessage(message) };
  });

  pi.on("agent_end", (event) => {
    const last = event.messages.at(-1) as AgentMessage | undefined;
    const message = last as Message | undefined;
    settledRetryProvider =
      message?.role === "assistant" &&
      message.stopReason === "error" &&
      isConcurrencyError(message.provider, message.errorMessage)
        ? message.provider
        : null;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (settledRetryProvider === null) return;
    const provider = settledRetryProvider;
    settledRetryProvider = null;
    if (ctx.hasPendingMessages()) return;

    consecutiveConcurrencyErrors += 1;
    const delayMs = nextRetryDelayMs(consecutiveConcurrencyErrors, null, __random.current);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${provider} concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
        "info",
      );
    }
    // No abort signal while idle; the isIdle() check below covers a user who
    // types during the wait.
    await __sleep.current(delayMs, undefined);
    if (!ctx.isIdle()) return;
    pi.sendMessage(
      { customType: STATUS_KEY, content: RETRY_TRIGGER_CONTENT, display: false },
      { triggerTurn: true },
    );
  });
}

/** Reset module state between tests. */
export function __resetRetryState(): void {
  consecutiveConcurrencyErrors = 0;
  lastRetryAfterMs = null;
  settledRetryProvider = null;
}
