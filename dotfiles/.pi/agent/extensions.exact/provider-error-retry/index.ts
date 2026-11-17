import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  extractErrorCodes,
  isZaiConcurrencyEvidence,
  ZAI_PROVIDER_IDS,
} from "../shared/zai-concurrency.ts";

export const RETRY_MESSAGE_PREFIX = "provider returned error: ";
export const FINISH_ERROR_PREFIX = "Provider finish_reason: ";
const RETRY_TRIGGER_CONTENT =
  "The previous request failed with a temporary provider concurrency limit. Continue the interrupted task.";
const STATUS_KEY = "provider-error-retry";

// ---- unknown finish_reason (immediate retry) ----------------------------------

// mapStopReason() が明示マップする finish_reason。リトライ方針は upstream に任せる。
const EXPLICIT_FINISH_REASONS = ["content_filter", "network_error"];

/** mapStopReason() marks unknown finish reasons as errors, but retry classification does not retry that message. */
export function isUnknownFinishErrorMessage(errorMessage: string): boolean {
  if (!errorMessage.startsWith(FINISH_ERROR_PREFIX)) return false;
  const reason = errorMessage.slice(FINISH_ERROR_PREFIX.length);
  return !EXPLICIT_FINISH_REASONS.includes(reason);
}

// ---- concurrency detection (fail-closed) --------------------------------------

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

const QUOTA_WORDING_PATTERN =
  /\b(?:quota|billing|balance|credit|insufficient_quota|usage[\s-]*(?:limit|window)|(?:monthly|weekly|daily)\s+limit|resets?)\b/i;
const GENERIC_CONCURRENCY_PATTERN =
  /\b(?:concurrent\s+requests?|concurrency\s+limit|too\s+many\s+concurrent|connection\s+limit\s+reached)\b/i;

function hasQuotaEvidence(errorMessage: string, codes: Set<string>): boolean {
  return (
    [...codes].some((code) => ZAI_QUOTA_CODES.has(code)) || QUOTA_WORDING_PATTERN.test(errorMessage)
  );
}

function isGenericConcurrencyEvidence(errorMessage: string): boolean {
  return GENERIC_CONCURRENCY_PATTERN.test(errorMessage);
}

type ConcurrencyDetector = (codes: Set<string>, errorMessage: string) => boolean;

/** Provider rules contain only evidence confirmed for that provider's adapter. */
const PROVIDER_DETECTORS = new Map<string, ConcurrencyDetector>(
  ZAI_PROVIDER_IDS.map((providerId) => [providerId, isZaiConcurrencyEvidence]),
);

/**
 * True only on explicit concurrency evidence. Quota/billing evidence wins
 * first; a provider with a dedicated rule never falls through to the generic
 * matcher, so wording-specific guarantees stay per-provider.
 */
export function isConcurrencyError(provider: string, errorMessage: string | undefined): boolean {
  if (errorMessage === undefined || errorMessage === "") return false;
  const codes = extractErrorCodes(errorMessage);
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
let settledRetryModel: { provider: string; model: string } | null = null;

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

export default function providerErrorRetryExtension(pi: ExtensionAPI): void {
  function recordRetryEvent(data: Record<string, unknown>): void {
    try {
      pi.appendEntry("provider-error-retry-event", data);
    } catch {
      return;
    }
  }
  pi.on("turn_end", (event) => {
    const message = event.message;
    if (
      message.role !== "assistant" ||
      (message.stopReason !== "error" && message.stopReason !== "aborted")
    )
      return;
    recordRetryEvent({
      event: "assistant_failure",
      phase: "turn_end",
      messageEntryId: event.messageEntryId,
      stopReason: message.stopReason,
    });
  });

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
    // Unknown finish reasons retry immediately: pi's built-in retry budget
    // paces them, so only the classification rewrite is needed. The rewrite
    // happens at most once per assistant error because each branch returns.
    if (isUnknownFinishErrorMessage(message.errorMessage ?? "")) {
      recordRetryEvent({
        event: "retryable_rewrite",
        phase: "message_end",
        classification: "unknown_finish_reason",
        provider: message.provider,
        model: message.model,
      });
      return { message: makeRetryableMessage(message) };
    }
    if (!isConcurrencyError(message.provider, message.errorMessage)) return;

    consecutiveConcurrencyErrors += 1;
    const retryAfterMs = takeRetryAfter();
    const delayMs = nextRetryDelayMs(consecutiveConcurrencyErrors, retryAfterMs, __random.current);
    const wait = {
      phase: "message_end",
      provider: message.provider,
      model: message.model,
      concurrencyCount: consecutiveConcurrencyErrors,
      delayMs,
      delaySource: retryAfterMs === null ? "backoff" : "retry_after",
    };
    recordRetryEvent({ ...wait, event: "concurrency_wait_start" });

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `${message.provider} concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
      );
    }
    // Pi's built-in retry starts with a shorter delay; wait here before
    // making this error retryable to pace concurrent requests.
    const waitCompleted = await __sleep.current(delayMs, ctx.signal);
    recordRetryEvent({
      ...wait,
      event: "concurrency_wait_end",
      outcome: waitCompleted ? "completed" : "interrupted",
    });
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    // Aborted mid-wait: let the turn end with the original error, the user
    // asked to stop.
    if (!waitCompleted) return;
    recordRetryEvent({
      event: "retryable_rewrite",
      phase: "message_end",
      classification: "concurrency",
      provider: message.provider,
      model: message.model,
      concurrencyCount: wait.concurrencyCount,
    });
    return { message: makeRetryableMessage(message) };
  });

  pi.on("agent_end", (event) => {
    const last = event.messages.at(-1) as AgentMessage | undefined;
    const message = last as Message | undefined;
    settledRetryModel =
      message?.role === "assistant" &&
      message.stopReason === "error" &&
      isConcurrencyError(message.provider, message.errorMessage)
        ? { provider: message.provider, model: message.model }
        : null;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (settledRetryModel === null) return;
    const model = settledRetryModel;
    const { provider } = model;
    settledRetryModel = null;
    if (ctx.hasPendingMessages()) {
      recordRetryEvent({
        ...model,
        event: "resend_skipped",
        phase: "agent_settled",
        reason: "pending_messages",
      });
      return;
    }

    consecutiveConcurrencyErrors += 1;
    const delayMs = nextRetryDelayMs(consecutiveConcurrencyErrors, null, __random.current);
    const wait = {
      ...model,
      phase: "agent_settled",
      concurrencyCount: consecutiveConcurrencyErrors,
      delayMs,
      delaySource: "backoff",
    };
    recordRetryEvent({ ...wait, event: "concurrency_wait_start" });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${provider} concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
        "info",
      );
    }
    // No abort signal while idle; the isIdle() check below covers a user who
    // types during the wait.
    const waitCompleted = await __sleep.current(delayMs, undefined);
    recordRetryEvent({
      ...wait,
      event: "concurrency_wait_end",
      outcome: waitCompleted ? "completed" : "interrupted",
    });
    if (!ctx.isIdle()) {
      recordRetryEvent({
        ...model,
        event: "resend_skipped",
        phase: "agent_settled",
        reason: "busy",
      });
      return;
    }
    // A fresh turn resets Pi's bounded agent retry budget after it runs out.
    recordRetryEvent({
      ...model,
      event: "resend_requested",
      phase: "agent_settled",
      concurrencyCount: wait.concurrencyCount,
    });
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
  settledRetryModel = null;
}
