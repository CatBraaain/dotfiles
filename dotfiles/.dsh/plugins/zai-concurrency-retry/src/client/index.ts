/**
 * Browser client half: render each retry wait as one transcript row.
 *
 * Registers (1) the Conversation Definition folding `zai-concurrency-retry/wait`
 * events — history included — into chat-target nodes, and (2) the
 * `conversation.chat.node` renderer keyed to this plugin's kind, drawing the
 * static one-line notice in gray at the wait's log position.
 */
import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// `ctx.uiConversation` and the ChatNodeDataMap merge surface.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { registerZaiRetryConversation } from "./conversation";
import { registerZaiRetryChatNode, type ZaiRetryWaitNode } from "./apply";
import { buildRetryWaitLine } from "./format";

/** Services this client half touches. */
export const inject = ["slots", "uiConversation"];

/** Gray secondary text matching the stock transcript notices (repo gray policy). */
const WAIT_STYLE: Readonly<Record<string, string>> = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
};

/** The transcript row: the static wait notice, one line, no live updates. */
function ZaiRetryWaitRow({ node }: { readonly node: ZaiRetryWaitNode }): ReactNode {
  return createElement("div", { style: WAIT_STYLE }, buildRetryWaitLine(node.data));
}

/** Wire the Conversation assembly and the chat-node renderer. */
export function apply(ctx: Context): void {
  registerZaiRetryConversation(ctx);
  registerZaiRetryChatNode(ctx, ZaiRetryWaitRow);
}
