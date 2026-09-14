/** Chat-node seat registration, kept react-free: the component passes through opaque. */
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// ChatNodeKind (kinded by the ChatNodeDataMap merge in `./conversation`).
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type { ChatNode } from "@deepseek-ai/dsh-client-ui-chat/client";
import { ZAI_RETRY_WAIT_EVENT_TYPE } from "./event";

/** The final Chat node this plugin's renderer receives. */
export type ZaiRetryWaitNode = ChatNode<typeof ZAI_RETRY_WAIT_EVENT_TYPE>;

/** Mount the wait row into the keyed chat-node seat (keyed by Definition kind). */
export function registerZaiRetryChatNode(
  ctx: Context,
  component: (props: { readonly node: ZaiRetryWaitNode }) => unknown,
): void {
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register(
      { name: "conversation.chat.node", key: ZAI_RETRY_WAIT_EVENT_TYPE },
      component,
    ),
  );
}
