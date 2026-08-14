import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /aside command extension.
 *
 * Appends text (empty allowed) to the session history as a message that
 * participates in LLM context, without triggering an AI response.
 * The appended message persists and is sent on every subsequent AI call,
 * in history order, just like a normal user message.
 *
 * pi has no API to append a role:"user" message without triggering a turn,
 * so this uses sendMessage with deliverAs:"nextTurn": the message is queued
 * for the next prompt and the LLM is not called. It is stored as a
 * CustomMessage (role:"custom"), which still participates in LLM context.
 */
export default function asideExtension(pi: ExtensionAPI): void {
  pi.registerCommand("aside", {
    description: "Append a message to the session history without triggering an AI response.",
    handler: async (args) => {
      pi.sendMessage(
        { customType: "aside", content: args, display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });
}
