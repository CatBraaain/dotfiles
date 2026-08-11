// new-session — agent-initiated "start a new session" tool with a mandatory
// owner confirmation dialog.
//
// The agent calls the `new_session` tool; the tool shows a confirm dialog and,
// only on approval, switches to a completely clean new session. Optionally the
// agent can supply a first message that is placed in the new session's editor.
//
// pi only lets command handlers call ctx.newSession(), not tools. So on approval
// the tool stages the kickoff and queues an internal /new-session follow-up
// command (pi.sendUserMessage deliverAs: "followUp"); that command performs the
// actual session switch. The observable behavior — propose -> confirm -> switch
// -> optional first-message draft — is unchanged.
//
// All routing decisions live in pure functions (decideOnApproval /
// newSessionKickoff / buildAgentResultText / normalizeFirstMessage /
// requestNewSession / consumePendingKickoff) so the spec is testable without
// the pi runtime. The factory is a thin glue layer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Tool name exposed to the LLM. */
export const NEW_SESSION_TOOL_NAME = "new_session";
/** Internal follow-up command that performs the actual session switch. */
export const NEW_SESSION_COMMAND_NAME = "new-session";

export const newSessionParameters = Type.Object({
  firstMessage: Type.Optional(
    Type.String({
      description:
        "First user message to place in the new session's editor as a draft. Omit to open an empty session.",
    }),
  ),
});
export type NewSessionInput = Static<typeof newSessionParameters>;

/** Exact wording of the owner confirmation dialog. */
export const CONFIRM_DIALOG_TITLE = "Start a new session?";
export const CONFIRM_DIALOG_BODY = "The agent is about to start a new session. Proceed?";

export type FirstMessage = string;

/** A blank/whitespace-only first message is treated as "no message". */
export function normalizeFirstMessage(raw: string | undefined): FirstMessage | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export type ApprovalDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "rejected" };

export function decideOnApproval(approved: boolean): ApprovalDecision {
  return approved ? { kind: "proceed" } : { kind: "rejected" };
}

/** How the new session opens, decided solely by the presence of a first message. */
export type NewSessionKickoff =
  | { readonly kind: "draft-first-message"; readonly message: FirstMessage }
  | { readonly kind: "empty" };

export function newSessionKickoff(firstMessage: FirstMessage | undefined): NewSessionKickoff {
  return firstMessage === undefined
    ? { kind: "empty" }
    : { kind: "draft-first-message", message: firstMessage };
}

/** Text returned to the agent so it can recognize approval vs rejection. */
export function buildAgentResultText(
  decision: ApprovalDecision,
  kickoff: NewSessionKickoff,
): string {
  if (decision.kind === "rejected") {
    return "The owner rejected the request to start a new session. Staying in the current session.";
  }
  return kickoff.kind === "draft-first-message"
    ? `The owner approved a new session. It will open with the first message in the editor: "${kickoff.message}".`
    : "The owner approved a new session. It will open as an empty session.";
}

let pendingKickoff: NewSessionKickoff | undefined;

export function __resetPendingKickoff(): void {
  pendingKickoff = undefined;
}

/**
 * Stage a kickoff for the follow-up command and invoke `send` with the command
 * line. Kept as a pure seam so the tool's "queue /new-session" step is testable
 * without the pi runtime.
 */
export function requestNewSession(
  kickoff: NewSessionKickoff,
  send: (commandLine: string) => void,
): void {
  pendingKickoff = kickoff;
  send(`/${NEW_SESSION_COMMAND_NAME}`);
}

/** Take and clear the staged kickoff. Falls back to an empty session if none. */
export function consumePendingKickoff(): NewSessionKickoff {
  const kickoff = pendingKickoff ?? { kind: "empty" };
  pendingKickoff = undefined;
  return kickoff;
}

export default function newSessionExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: NEW_SESSION_TOOL_NAME,
    label: "New Session",
    description:
      "Propose starting a new, completely clean session. Always asks the owner to confirm before switching. " +
      "Nothing from the current session is carried over. " +
      "Pass firstMessage to place it in the new session's editor as a draft.",
    promptSnippet: "Propose a new session (the owner must confirm)",
    parameters: newSessionParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const firstMessage = normalizeFirstMessage(params.firstMessage);
      const approved = await ctx.ui.confirm(CONFIRM_DIALOG_TITLE, CONFIRM_DIALOG_BODY);
      const decision = decideOnApproval(approved);
      const kickoff = newSessionKickoff(firstMessage);

      if (decision.kind === "rejected") {
        ctx.ui.notify("New session request rejected", "info");
        return {
          content: [{ type: "text" as const, text: buildAgentResultText(decision, kickoff) }],
          details: { approved: false },
        };
      }

      requestNewSession(kickoff, (commandLine) => {
        pi.sendUserMessage(commandLine, { deliverAs: "followUp" });
      });
      return {
        content: [{ type: "text" as const, text: buildAgentResultText(decision, kickoff) }],
        details: { approved: true, kickoff },
      };
    },
  });

  pi.registerCommand(NEW_SESSION_COMMAND_NAME, {
    description: "Start a clean new session (internal bridge used by the new_session tool).",
    handler: async (_args, ctx) => {
      const kickoff = consumePendingKickoff();
      // No parentSession, no setup: the new session is completely clean and
      // carries nothing over from the current session.
      await ctx.newSession({
        withSession: async (replacementCtx) => {
          if (kickoff.kind === "draft-first-message") {
            replacementCtx.ui.setEditorText(kickoff.message);
          }
        },
      });
    },
  });
}
