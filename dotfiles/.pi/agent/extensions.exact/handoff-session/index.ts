import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const HANDOFF_SESSION_COMMAND_NAME = "handoff-session-apply";

const CONFIRM_TITLE = "Handoff session";
const HANDOFF_OPTION = "Yes, handoff";
const STAY_OPTION = "No, stay (reason next)";
const DENIAL_REASON_INPUT_TITLE = "Denied. Optional reason for the agent:";

interface HandoffPayload {
  reason: string;
  handoff: string;
}

// The command handler receives a single args string. encodeURIComponent escapes
// spaces to %20, so the first raw space safely separates the two values.
function encodeHandoffPayload(payload: HandoffPayload): string {
  return `${encodeURIComponent(payload.reason)} ${encodeURIComponent(payload.handoff)}`;
}

function decodeHandoffPayload(args: string): HandoffPayload | undefined {
  const separatorIndex = args.indexOf(" ");
  if (separatorIndex === -1) return undefined;
  const reason = decodeURIComponent(args.slice(0, separatorIndex));
  const handoff = decodeURIComponent(args.slice(separatorIndex + 1));
  if (!reason.trim() || !handoff.trim()) return undefined;
  return { reason, handoff };
}

export default function handoffSessionExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "handoff_session",
    label: "Handoff Session",
    description:
      "Use this tool only when a context reset is needed before a substantial next work phase. " +
      "Do not use it for ordinary completion reports, owner decisions, or finish/discard worktree approval; " +
      "when only approval remains, report Ready or Waiting and ask normally. " +
      "After the owner confirms, end the current session and move to a brand-new session. " +
      "reason explains why the current session ends; handoff is the natural-language prompt " +
      "automatically sent as the first user message of the new session.",
    promptGuidelines: [
      "handoff_session は、コンテキストをリセットして長い次の作業 phaseへ移るときだけ使う。収束ループ開始前、または実装・レビュー完了後に次の長い phaseがある場合が対象であり、実装・レビュー完了だけでは使わない。finish wt・discardの承認待ち、ownerの判断待ち、単なる作業完了報告では使わず、ReadyまたはWaitingとして通常の質問で終了する。handoffには目的、spec・workファイルのパス、決定事項、完了済みの作業と検証、未解決事項、次のphaseの完了条件を含める。オーナーの承認後は新しいmain agentとして再開し、次のphaseを別のseniorに委譲する。確認UIで拒否された場合は、入力された理由を `no(<理由>)` として現在のagentへ返す。",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the current session ends (non-empty)" }),
      handoff: Type.String({
        description:
          "Prompt to auto-send to the next agent: continuation goal, approved spec paths, decisions, work state, open questions, done conditions",
      }),
    }),
    async execute(_toolCallId, params) {
      void _toolCallId;
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const handoff = typeof params.handoff === "string" ? params.handoff.trim() : "";
      if (!reason || !handoff) {
        return {
          content: [
            { type: "text" as const, text: "Both reason and handoff must be non-empty strings." },
          ],
          isError: true,
          details: {},
        };
      }

      // Tools run with ExtensionContext, which has no newSession. Queue the
      // internal command as a follow-up so it runs after the current turn
      // completes, with ExtensionCommandContext available.
      pi.sendUserMessage(
        `/${HANDOFF_SESSION_COMMAND_NAME} ${encodeHandoffPayload({ reason, handoff })}`,
        {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: "Handoff queued. A confirmation dialog opens after this turn completes.",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerCommand(HANDOFF_SESSION_COMMAND_NAME, {
    description:
      "Internal: confirm and apply the session handoff queued by the handoff_session tool.",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const payload = decodeHandoffPayload(args);
      if (!payload) {
        ctx.ui.notify(
          "handoff-session: invalid handoff payload; staying in the current session",
          "error",
        );
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "handoff-session: interactive UI is unavailable; staying in the current session",
          "error",
        );
        return;
      }

      const confirmationMessage = `End this session?\n\nReason:\n${payload.reason}\n\nPrompt for the next agent:\n${payload.handoff}`;
      const approved = ctx.ui.select
        ? (await ctx.ui.select(`${CONFIRM_TITLE}\n\n${confirmationMessage}`, [
            HANDOFF_OPTION,
            STAY_OPTION,
          ])) === HANDOFF_OPTION
        : await ctx.ui.confirm(CONFIRM_TITLE, confirmationMessage);
      if (!approved) {
        const denialReason = (await ctx.ui.input?.(DENIAL_REASON_INPUT_TITLE))?.trim();
        pi.sendUserMessage(`no(${denialReason ?? ""})`, { deliverAs: "followUp" });
        return;
      }

      try {
        const result = await ctx.newSession({
          withSession: async (newSessionContext) => {
            try {
              await newSessionContext.sendUserMessage(payload.handoff);
            } catch (error) {
              // The switch already happened; keep the new session and report.
              newSessionContext.ui.notify(
                `handoff-session: failed to send the initial prompt; staying in the new session (${errorMessage(error)})`,
                "error",
              );
            }
          },
        });
        if (result.cancelled) {
          ctx.ui.notify(
            "handoff-session: session migration was cancelled; staying in the current session",
            "error",
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `handoff-session: session migration failed; staying in the current session (${errorMessage(error)})`,
          "error",
        );
      }
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
