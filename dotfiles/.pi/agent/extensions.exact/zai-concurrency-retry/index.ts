/**
 * Indefinite wait-and-retry for Z.AI coding-plan concurrency errors (1302/1305).
 *
 * pi's built-in agent retry already retries these errors, but its budget is
 * finite (settings.retry.maxRetries) and its backoff starts near zero, so
 * concurrent runs keep hammering Z.AI until every session fails. This extension
 * makes the retry loop unbounded and paced:
 *
 *   turn path    — message_end waits out the backoff, then rewrites the error
 *                  into a retryable message so pi's agent retry replays it.
 *                  Budget-limited (typically settings.retry.maxRetries tries).
 *   settled path — once the turn has fully settled on a concurrency error,
 *                  wait, then re-trigger the turn via pi.sendMessage. This
 *                  resets pi's retry budget, making the overall loop unbounded.
 *
 * Detection and backoff live in ../shared/zai-concurrency.ts, which the agents
 * extension also uses to keep these errors out of its model-fallback path.
 * 詳細は ./SPEC.md。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  isZaiConcurrencyLimited,
  isZaiProvider,
  nextRetryDelayMs,
  parseRetryAfterMs,
} from "../shared/zai-concurrency.ts";

export const RETRY_MESSAGE_PREFIX = "provider returned error: ";
const RETRY_TRIGGER_CONTENT =
  "The previous request failed with a temporary Z.AI concurrency limit (error 1302/1305). Continue the interrupted task.";
const STATUS_KEY = "zai-concurrency-retry";

let consecutiveConcurrencyErrors = 0;
let lastRetryAfterMs: number | null = null;
let lastTurnEndedOnConcurrencyError = false;

/** Replace the error text with a form pi's built-in retry treats as retryable. */
export function makeRetryableMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, errorMessage: `${RETRY_MESSAGE_PREFIX}${message.errorMessage ?? ""}` };
}

/** True when the turn's last message is a Z.AI concurrency error. */
function isConcurrencyAssistantError(
  message: AgentMessage | undefined,
): message is AssistantMessage {
  if (message === undefined || (message as Message).role !== "assistant") return false;
  const assistant = message as AssistantMessage;
  return (
    assistant.stopReason === "error" &&
    isZaiProvider(assistant.provider) &&
    isZaiConcurrencyLimited(assistant.errorMessage)
  );
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

export default function zaiConcurrencyRetryExtension(pi: ExtensionAPI): void {
  // Remember Z.AI Retry-After so the message_end wait can honor it. pi's agent
  // retry is errorMessage-based and drops headers, so this hook is the only
  // place they are observable.
  pi.on("after_provider_response", (event, ctx) => {
    if (event.status !== 429 || !ctx.model) return;
    if (!isZaiProvider(ctx.model.provider)) return;
    lastRetryAfterMs = parseRetryAfterMs(event.headers["retry-after"]);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as Message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") {
      consecutiveConcurrencyErrors = 0;
      return;
    }
    if (!isZaiProvider(message.provider)) return;
    if (!isZaiConcurrencyLimited(message.errorMessage)) return;

    consecutiveConcurrencyErrors += 1;
    const delayMs = nextRetryDelayMs(
      consecutiveConcurrencyErrors,
      takeRetryAfter(),
      __random.current,
    );

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `Z.AI concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
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
    lastTurnEndedOnConcurrencyError = isConcurrencyAssistantError(event.messages.at(-1));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!lastTurnEndedOnConcurrencyError) return;
    lastTurnEndedOnConcurrencyError = false;
    if (ctx.hasPendingMessages()) return;

    consecutiveConcurrencyErrors += 1;
    const delayMs = nextRetryDelayMs(consecutiveConcurrencyErrors, null, __random.current);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Z.AI concurrency limit; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveConcurrencyErrors})`,
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
  lastTurnEndedOnConcurrencyError = false;
}
