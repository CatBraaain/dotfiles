/** Chat-node seat registration, kept react-free: the component passes through opaque. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type { ChatNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import { CONCURRENCY_RETRY_WAIT_EVENT_TYPE } from "./event";

export type ConcurrencyRetryWaitNode = ChatNode<typeof CONCURRENCY_RETRY_WAIT_EVENT_TYPE>;

/** Mount the wait row into the keyed chat-node seat. */
export function registerConcurrencyRetryChatNode(
  ctx: Context,
  component: (props: { readonly node: ConcurrencyRetryWaitNode }) => unknown,
): void {
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      { name: "conversation.chat.node", key: CONCURRENCY_RETRY_WAIT_EVENT_TYPE },
      component,
    ),
  );
}
