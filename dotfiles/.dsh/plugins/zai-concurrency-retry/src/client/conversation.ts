/**
 * Client-side Conversation assembly: one chat Node per retry wait.
 *
 * Every `zai-concurrency-retry/wait` session event is an independent start —
 * the host appends exactly one per wait and no completion event exists, so
 * each Context folds a single event into one `chat`-target node. History
 * pages included: the engine replays the logged prefix through `match`, so
 * reloads and older logs re-render the rows. The node is drawn by the
 * `conversation.chat.node` seat entry registered in `./apply`.
 */
import type { Context } from "@deepseek-ai/cordis";
// `ctx.uiConversation` and the Conversation contracts.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  ConversationLocation,
  ConversationNodeDefinition,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
// ChatNodeDataMap merge surface (the public plugin extension point).
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { ZAI_RETRY_WAIT_EVENT_TYPE } from "./event";
import type { ZaiRetryWaitData } from "../index";

/** The chat-node renderer kind this plugin occupies (its event type). */
export type ZaiRetryWaitKind = typeof ZAI_RETRY_WAIT_EVENT_TYPE;

declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap {
    [ZAI_RETRY_WAIT_EVENT_TYPE]: ZaiRetryWaitData;
  }
}

/** Extract a valid wait payload from a `zai-concurrency-retry/wait` event. */
export function waitEventData(data: unknown): ZaiRetryWaitData | undefined {
  const record = data as
    | { readonly provider?: unknown; readonly attempt?: unknown; readonly waitMs?: unknown }
    | undefined;
  if (typeof record?.provider !== "string" || record.provider === "") return undefined;
  if (typeof record?.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 1)
    return undefined;
  if (typeof record?.waitMs !== "number" || !Number.isFinite(record.waitMs) || record.waitMs <= 0)
    return undefined;
  return { provider: record.provider, attempt: record.attempt, waitMs: record.waitMs };
}

/** Per-Context state: the wait payload and the seq that recorded it. */
interface ZaiRetryWaitState {
  readonly data: ZaiRetryWaitData;
  readonly seq: number;
}

/**
 * One Context per wait event. Each event is a start (log-only events never
 * update); a malformed payload is skipped rather than guessed at.
 */
export const zaiRetryWaitDefinition: ConversationNodeDefinition<ZaiRetryWaitState> = {
  kind: ZAI_RETRY_WAIT_EVENT_TYPE,
  target: "chat",
  match(event) {
    if (event.type !== ZAI_RETRY_WAIT_EVENT_TYPE) return null;
    return waitEventData(event.data) === undefined ? null : { id: `wait-${event.seq}`, role: "start" };
  },
  start(_context, match) {
    const data = waitEventData(match.event.data);
    if (data === undefined) {
      throw new Error("zai-concurrency-retry/wait start requires a valid payload");
    }
    return { data, seq: match.event.seq };
  },
  update(context) {
    return context.state;
  },
  buildViewNode(context) {
    const state = context.state;
    if (state === undefined) return null;
    const location: ConversationLocation =
      context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
    return {
      key: context.key,
      kind: ZAI_RETRY_WAIT_EVENT_TYPE,
      id: context.id,
      target: "chat",
      anchorSeq: state.seq,
      location,
      visibility: "visible" as const,
      data: state.data,
    };
  },
};

/** Register the Definition (event → Context state → chat node). */
export function registerZaiRetryConversation(ctx: Context): void {
  ctx.uiConversation.events.register(zaiRetryWaitDefinition);
}
