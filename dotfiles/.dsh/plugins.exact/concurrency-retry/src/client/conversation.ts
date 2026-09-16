/**
 * Client-side Conversation assembly: one chat Node per retry wait.
 *
 * Every `concurrency-retry/wait` session event is an independent start — the
 * host appends exactly one per wait and no completion event exists, so each
 * Context folds a single event into one `chat`-target node. History pages are
 * included because the engine replays logged events through `match`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ConversationLocation,
  ConversationNodeDefinition,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { CONCURRENCY_RETRY_WAIT_EVENT_TYPE } from "./event";
import type { ConcurrencyRetryWaitData } from "../index";

export type ConcurrencyRetryWaitKind = typeof CONCURRENCY_RETRY_WAIT_EVENT_TYPE;

declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap {
    [CONCURRENCY_RETRY_WAIT_EVENT_TYPE]: ConcurrencyRetryWaitData;
  }
}

/** Extract a valid wait payload; malformed events are not guessed at. */
export function waitEventData(data: unknown): ConcurrencyRetryWaitData | undefined {
  const record = data as
    | { readonly provider?: unknown; readonly attempt?: unknown; readonly waitMs?: unknown }
    | undefined;
  if (typeof record?.provider !== "string" || record.provider === "") return undefined;
  if (
    typeof record?.attempt !== "number" ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 1
  )
    return undefined;
  if (typeof record?.waitMs !== "number" || !Number.isFinite(record.waitMs) || record.waitMs <= 0)
    return undefined;
  return { provider: record.provider, attempt: record.attempt, waitMs: record.waitMs };
}

interface ConcurrencyRetryWaitState {
  readonly data: ConcurrencyRetryWaitData;
  readonly seq: number;
}

export const concurrencyRetryWaitDefinition: ConversationNodeDefinition<ConcurrencyRetryWaitState> =
  {
    kind: CONCURRENCY_RETRY_WAIT_EVENT_TYPE,
    target: "chat",
    match(event) {
      if (event.type !== CONCURRENCY_RETRY_WAIT_EVENT_TYPE) return null;
      return waitEventData(event.data) === undefined
        ? null
        : { id: `wait-${event.seq}`, role: "start" };
    },
    start(_context, match) {
      const data = waitEventData(match.event.data);
      if (data === undefined) {
        throw new Error("concurrency-retry/wait start requires a valid payload");
      }
      return { data, seq: match.event.seq };
    },
    update(context) {
      return context.state;
    },
    buildViewNode(context) {
      const state = context.state;
      if (state === undefined) return null;
      const location: ConversationLocation = context.start?.location ??
        context.matches[0]?.location ?? { kind: "unresolved" };
      return {
        key: context.key,
        kind: CONCURRENCY_RETRY_WAIT_EVENT_TYPE,
        id: context.id,
        target: "chat",
        anchorSeq: state.seq,
        location,
        visibility: "visible" as const,
        data: state.data,
      };
    },
  };

export function registerConcurrencyRetryConversation(ctx: Context): void {
  ctx.uiConversation.events.register(concurrencyRetryWaitDefinition);
}
