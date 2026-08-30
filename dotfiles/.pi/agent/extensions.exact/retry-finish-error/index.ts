/**
 * Retry on Provider finish_reason: error
 *
 * Some OpenAI-compatible providers return an unknown `finish_reason` (e.g. "error",
 * "timeout") instead of the standard set. `pi-ai`'s mapStopReason() maps any
 * unrecognized finish_reason to `{ stopReason: "error", errorMessage:
 * "Provider finish_reason: ${reason}" }`. That message does NOT match
 * RETRYABLE_PROVIDER_ERROR_PATTERN, so pi's built-in auto-retry never fires for it.
 *
 * This extension rewrites such messages on `message_end` so the built-in retry
 * budget (`settings.retry`) kicks in and the same model is retried with backoff.
 *
 * Scope: only the generic unknown-finish_reason branch. `content_filter` and
 * `network_error` are mapped explicitly by mapStopReason() and are intentionally
 * left untouched: content filtering is deterministic and network_error already
 * matches the upstream retryable pattern.
 *
 * 詳細は ./SPEC.md。
 */

import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export const FINISH_ERROR_PREFIX = "Provider finish_reason: ";
export const RETRYABLE_PREFIX = "provider returned error: ";

/** mapStopReason() が明示マップする finish_reason。リトライ方針は upstream に任せる。 */
const EXPLICIT_FINISH_REASONS = ["content_filter", "network_error"];

function isUnknownFinishErrorMessage(message: string): boolean {
  if (!message.startsWith(FINISH_ERROR_PREFIX)) return false;
  const reason = message.slice(FINISH_ERROR_PREFIX.length);
  return !EXPLICIT_FINISH_REASONS.includes(reason);
}

function makeRetryable(message: AssistantMessage): AssistantMessage {
  const errorMessage = message.errorMessage ?? "provider request failed";
  return {
    ...message,
    errorMessage: `${RETRYABLE_PREFIX}${errorMessage}`,
  };
}

/** message_end イベントを判定し、リトライ可能に書き換えるか決める。テスト用に export。 */
export function handleFinishErrorMessage(event: MessageEndEvent): { message: Message } | undefined {
  const message = event.message as Message;
  if (message.role !== "assistant" || message.stopReason !== "error") return;
  if (!message.errorMessage || !isUnknownFinishErrorMessage(message.errorMessage)) return;

  return { message: makeRetryable(message) };
}

export default function retryFinishErrorExtension(pi: ExtensionAPI): void {
  pi.on("message_end", async (event) => {
    return handleFinishErrorMessage(event);
  });
}
