/**
 * Browser client half: render each retry wait as one transcript row.
 *
 * The durable event is folded into a chat-target node so current and historic
 * waits render identically after a reload.
 */
import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { registerConcurrencyRetryConversation } from "./conversation";
import { registerConcurrencyRetryChatNode, type ConcurrencyRetryWaitNode } from "./apply";
import { buildRetryWaitLine } from "./format";

export const inject = ["slots", "uiConversation"];

/** Gray secondary text matching stock transcript notices. */
const WAIT_STYLE: Readonly<Record<string, string>> = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
};

function ConcurrencyRetryWaitRow({ node }: { readonly node: ConcurrencyRetryWaitNode }): ReactNode {
  return createElement("div", { style: WAIT_STYLE }, buildRetryWaitLine(node.data));
}

export function apply(ctx: Context): void {
  registerConcurrencyRetryConversation(ctx);
  registerConcurrencyRetryChatNode(ctx, ConcurrencyRetryWaitRow);
}
