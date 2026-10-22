import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_TYPE = "handoff-session-counter";
const STATE_VERSION = 1;
const AUTO_HANDOFF_LIMIT = 2;
const HANDOFF_OPTION = "Yes, replace context";
const STAY_OPTION = "No, stay (reason next)";

interface HandoffPayload {
  reason: string;
  handoff: string;
}

export default function replaceContextExtension(pi: ExtensionAPI): void {
  const pendingRequests = new Map<string, HandoffPayload>();
  pi.on("turn_start", () => {
    pendingRequests.clear();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      pi.appendEntry(STATE_TYPE, counterState(0));
    }
  });

  pi.registerTool({
    name: "replace_context",
    label: "Replace Context",
    description:
      "Use this tool only when a context reset is needed before a substantial next work phase. " +
      "Do not use it for ordinary completion reports, owner decisions, or finish/discard worktree approval; " +
      "when only approval remains, report Ready or Waiting and ask normally. " +
      "Keep raw history in this session and replace prior model context with handoff, without LLM summarization. " +
      "The first two context replacements after user input or approval are automatic; the third requires approval.",
    promptGuidelines: [
      "Use replace_context only before a substantial next phase, such as a convergence loop or long work after implementation or review. Do not call it just because work finished. For finish/discard approval, owner decisions, or completion reports, report Ready or Waiting and ask normally. Include the goal, approved spec and work file paths, decisions, completed work and checks, open questions, and completion conditions in handoff. Continue as the main agent and delegate the next phase to another senior. If approval is denied, the current agent receives no(<reason>).",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the context reset is needed (non-empty)" }),
      handoff: Type.String({
        description: "Self-contained prompt for the next work phase (non-empty)",
      }),
    }),
    async execute(toolCallId, params) {
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const handoff = typeof params.handoff === "string" ? params.handoff.trim() : "";
      if (!reason || !handoff) {
        return {
          content: [{ type: "text", text: "Both reason and handoff must be non-empty strings." }],
          isError: true,
          details: undefined,
        };
      }
      pendingRequests.set(toolCallId, { reason, handoff });
      return {
        content: [
          { type: "text", text: "Context replacement requested for the end of this turn." },
        ],
        details: { reason, handoff },
      };
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    const directRequests = event.toolResults.filter(
      (result) => result.toolName === "replace_context",
    );
    const nestedRequests = event.toolResults.flatMap((result) =>
      (result.nestedCalls?.calls ?? []).flatMap((call) => {
        const payload = pendingRequests.get(call.id);
        return call.name === "replace_context" && call.status === "ok" && payload
          ? [{ toolCallId: call.id, details: payload }]
          : [];
      }),
    );
    pendingRequests.clear();
    const requests = [...directRequests, ...nestedRequests];
    if (requests.length === 0) return;
    const unsafeTurn =
      requests.length !== 1 ||
      event.outcome !== "completed" ||
      ctx.signal?.aborted ||
      event.toolResults.some(
        (result) =>
          result.isError ||
          result.nestedCalls?.complete === false ||
          result.nestedCalls?.calls.some((call) => call.status !== "ok"),
      ) ||
      (event.message.role === "assistant" && event.message.stopReason !== "toolUse");
    if (unsafeTurn) return;

    const payload = requests[0]?.details;
    if (!isHandoffPayload(payload)) return;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "replace-context: interactive UI is unavailable; keeping the current context",
        "error",
      );
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const requestId = `${event.messageEntryId}:${requests[0]?.toolCallId}`;
    const alreadyApplied = branch.some(
      (entry) =>
        entry.type === "compaction" &&
        isRecord(entry.details) &&
        entry.details.type === STATE_TYPE &&
        entry.details.requestId === requestId,
    );
    if (alreadyApplied) return;
    const leafId = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    function isCurrentRequest(): boolean {
      if (ctx.signal?.aborted) return false;
      const contextChanged =
        ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.sessionManager.getLeafId() !== leafId;
      if (contextChanged) {
        ctx.ui.notify(
          "replace-context: session changed while waiting; keeping the current context",
          "warning",
        );
      }
      return !contextChanged;
    }
    const count = readCounter(branch);
    const requiresApproval = count >= AUTO_HANDOFF_LIMIT;
    if (requiresApproval) {
      const title = "Replace context";
      const message = `Replace the model context in this session?\n\nReason:\n${payload.reason}\n\nPrompt for the next agent:\n${payload.handoff}`;
      try {
        const approved = ctx.ui.select
          ? (await ctx.ui.select(`${title}\n\n${message}`, [HANDOFF_OPTION, STAY_OPTION])) ===
            HANDOFF_OPTION
          : await ctx.ui.confirm(title, message);
        if (!isCurrentRequest()) return;
        if (!approved) {
          const reason = (await ctx.ui.input("Denied. Optional reason for the agent:"))?.trim();
          if (!isCurrentRequest()) return;
          pi.sendUserMessage(`no(${reason ?? ""})`, { deliverAs: "followUp" });
          return;
        }
      } catch (error) {
        ctx.ui.notify(`replace-context: confirmation failed (${errorMessage(error)})`, "error");
        return;
      }
    }
    if (!isCurrentRequest()) return;
    return {
      entries: [
        ...event.entries,
        {
          type: "compaction",
          summary: payload.handoff,
          firstKeptEntryId: null,
          details: {
            ...counterState(requiresApproval ? 0 : count + 1),
            requestId,
          },
        },
      ],
      continue: true,
    };
  });
}

function counterState(count: number) {
  return { type: STATE_TYPE, version: STATE_VERSION, count };
}

function readCounter(branch: SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    const state =
      entry.type === "custom" && entry.customType === STATE_TYPE
        ? entry.data
        : entry.type === "compaction"
          ? entry.details
          : undefined;
    const isCounterEntry = entry.type === "custom" && entry.customType === STATE_TYPE;
    if (!isCounterEntry && (!isRecord(state) || state.type !== STATE_TYPE)) continue;
    if (!isRecord(state)) return AUTO_HANDOFF_LIMIT;
    if (
      state.type !== STATE_TYPE ||
      state.version !== STATE_VERSION ||
      !Number.isInteger(state.count) ||
      typeof state.count !== "number" ||
      state.count < 0 ||
      state.count > AUTO_HANDOFF_LIMIT
    ) {
      return AUTO_HANDOFF_LIMIT;
    }
    return state.count;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHandoffPayload(value: unknown): value is HandoffPayload {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    typeof value.handoff === "string" &&
    value.handoff.trim().length > 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
