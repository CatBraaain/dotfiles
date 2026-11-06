import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestClassChange } from "../agents/class-change.ts";
import {
  createReplacement,
  REPLACEMENT_STATE,
  replacementCommitDraft,
  pendingProjection,
  projectPendingMessages,
  replacementEdits,
  type ReplacementProjection,
} from "./projection.ts";
import { installProviderGates, type ProviderGates } from "./provider-gate.ts";

const STATE_TYPE = "handoff-session-counter";
const STATE_VERSION = 1;
const AUTO_HANDOFF_LIMIT = 2;
const HANDOFF_OPTION = "Yes, recontext";
const STAY_OPTION = "No, stay (reason next)";
const PREPARATION_WIDGET = "recontext-preparation";
const SESSION_CHANGED_NOTICE =
  "recontext: session changed while waiting; keeping the current context";

export interface HandoffPayload {
  reason: string;
  handoff: string;
  class: string | undefined;
}

export default function recontextExtension(pi: ExtensionAPI): void {
  const pendingRequests = new Map<string, HandoffPayload>();
  let currentContext: ExtensionContext;
  let gates: ProviderGates | undefined;
  let widgetOwner: ProviderGates | undefined;
  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    gates?.close();
    gates = installProviderGates(pi, () => currentContext);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const owner = gates;
    gates = undefined;
    if (owner) clearPreparationWidget(owner, ctx);
    owner?.close();
  });
  pi.on("resources_discover", (_event, ctx) => {
    const owner = gates;
    if (!owner) return;
    let started = false;
    function prepareInBackground(): void {
      if (!owner || started || gates !== owner) return;
      started = true;
      void owner.ensure().then(
        () => clearPreparationWidget(owner, ctx),
        (error) => {
          if (gates !== owner) return;
          clearPreparationWidget(owner, ctx);
          ctx.ui.notify(`recontext: ${errorMessage(error)}`, "error");
        },
      );
    }
    if (ctx.mode === "tui") {
      widgetOwner = owner;
      ctx.ui.setWidget(PREPARATION_WIDGET, () => ({
        render() {
          prepareInBackground();
          return [];
        },
        invalidate() {},
      }));
    } else prepareInBackground();
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await ensureGates(ctx);
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!(await ensureGates(ctx))) return { cancel: true };
  });
  pi.on("session_before_tree", async (_event, ctx) => {
    if (!(await ensureGates(ctx))) return { cancel: true };
  });
  pi.on("turn_start", async (_event, ctx) => {
    await ensureGates(ctx);
    pendingRequests.clear();
  });
  pi.on("context", async (event, ctx) => {
    if (!(await ensureGates(ctx))) return;
    return { messages: projectPendingMessages(event.messages, ctx.sessionManager) };
  });
  pi.on("cache_warming_decision", async (_event, ctx) => {
    if (!(await ensureGates(ctx)) || gates?.isBusy()) return { action: "stop" };
  });
  pi.on("agent_before_settle", (event, ctx) => {
    const pending = pendingProjection(ctx.sessionManager, event.context.contextEntries);
    if (pending.drafts.length) return { entries: [...event.entries, ...pending.drafts] };
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      pi.appendEntry(STATE_TYPE, counterState(0));
    }
  });

  pi.registerTool({
    name: "recontext",
    label: "Recontext",
    description:
      "Use this tool only when a context reset is needed before a substantial next work phase. " +
      "Do not use it for ordinary completion reports, owner decisions, or finish/discard worktree approval; " +
      "when only approval remains, report Ready or Waiting and ask normally. " +
      "Keep raw history in this session and replace prior model context with handoff, without LLM summarization. " +
      "The first two context replacements after user input or approval are automatic; the third requires approval. " +
      "That approval prompt is shown by this tool at the turn boundary, so do not ask the user for it in advance.",
    promptGuidelines: [
      "Use recontext only before a substantial next phase, such as a convergence loop or long work after implementation or review. Do not call it just because work finished. For finish/discard approval, owner decisions, or completion reports, report Ready or Waiting and ask normally. Include the goal, approved spec and work file paths, decisions, completed work and checks, open questions, and completion conditions in handoff. Continue as the main agent and delegate the next phase to another senior. If approval is denied, the current agent receives no(<reason>). The approval prompt for the third replacement is shown by this tool at the end of the turn; do not ask the user for it in advance.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the context reset is needed (non-empty)" }),
      handoff: Type.String({
        description: "Self-contained prompt for the next work phase (non-empty)",
      }),
      class: Type.Optional(
        Type.String({
          description:
            'Effective model class for the next phase, such as "high", "middle", or "low". ' +
            'Use "high" for demanding phases like design, integration, or complex debugging, ' +
            '"middle" for ordinary work, and "low" for light routine work. ' +
            "Omit it to keep the current class.",
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const handoff = typeof params.handoff === "string" ? params.handoff.trim() : "";
      const requestedClass =
        params.class === undefined
          ? undefined
          : typeof params.class === "string"
            ? params.class.trim()
            : "";
      if (!reason || !handoff) {
        return {
          content: [{ type: "text", text: "Both reason and handoff must be non-empty strings." }],
          isError: true,
          details: undefined,
        };
      }
      if (params.class !== undefined && !requestedClass) {
        return {
          content: [{ type: "text", text: "class must be a non-empty string when provided." }],
          isError: true,
          details: undefined,
        };
      }
      pendingRequests.set(toolCallId, { reason, handoff, class: requestedClass });
      return {
        content: [
          { type: "text", text: "Context replacement requested for the end of this turn." },
        ],
        details:
          requestedClass === undefined
            ? { reason, handoff }
            : { reason, handoff, class: requestedClass },
      };
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    const pending = pendingProjection(
      ctx.sessionManager,
      event.context.contextEntries.length ? event.context.contextEntries : undefined,
    );
    const result = await applyManualHandoff(event, ctx, pending);
    return (
      result ??
      (pending.drafts.length ? { entries: [...event.entries, ...pending.drafts] } : undefined)
    );
  });

  function clearPreparationWidget(owner: ProviderGates, ctx: ExtensionContext): void {
    if (widgetOwner !== owner) return;
    widgetOwner = undefined;
    ctx.ui.setWidget(PREPARATION_WIDGET, undefined);
  }

  async function ensureGates(ctx: ExtensionContext): Promise<boolean> {
    currentContext = ctx;
    const owner = gates;
    try {
      if (!owner) throw new Error("Provider preparation owner is closed");
      await owner.ensure();
      return true;
    } catch (error) {
      ctx.abort();
      ctx.ui.notify(`recontext: ${errorMessage(error)}`, "error");
      return false;
    } finally {
      if (owner) clearPreparationWidget(owner, ctx);
    }
  }

  async function applyManualHandoff(
    event: TurnEndEvent,
    ctx: ExtensionContext,
    pending: ReplacementProjection,
  ): Promise<BoundaryResult | undefined> {
    const directRequests = event.toolResults.filter((result) => result.toolName === "recontext");
    const nestedRequests = event.toolResults.flatMap((result) =>
      (result.nestedCalls?.calls ?? []).flatMap((call) => {
        const payload = pendingRequests.get(call.id);
        return call.name === "recontext" && call.status === "ok" && payload
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
        "recontext: interactive UI is unavailable; keeping the current context",
        "error",
      );
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const requestId = `${event.messageEntryId}:${requests[0]?.toolCallId}`;
    const alreadyApplied = branch.some((entry) => {
      const state =
        entry.type === "custom" && entry.customType === STATE_TYPE
          ? entry.data
          : entry.type === "compaction"
            ? entry.details
            : undefined;
      return isRecord(state) && state.type === STATE_TYPE && state.requestId === requestId;
    });
    if (alreadyApplied) return;
    let baselineLeafId = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    function isCurrentRequest(): boolean {
      if (ctx.signal?.aborted) return false;
      const contextChanged =
        ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.sessionManager.getLeafId() !== baselineLeafId;
      if (contextChanged) {
        ctx.ui.notify(SESSION_CHANGED_NOTICE, "warning");
      }
      return !contextChanged;
    }
    const count = readCounter(branch);
    const requiresApproval = count >= AUTO_HANDOFF_LIMIT;
    if (requiresApproval) {
      const title = "Recontext";
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
        ctx.ui.notify(`recontext: confirmation failed (${errorMessage(error)})`, "error");
        return;
      }
    }
    if (!isCurrentRequest()) return;
    if (payload.class) {
      try {
        await requestClassChange(pi.events, {
          class: payload.class,
          context: ctx,
          source: "agent",
          preserveManualSelection: true,
          requiredAgent: "main",
        });
      } catch (error) {
        ctx.ui.notify(`recontext: class change failed (${errorMessage(error)})`, "error");
        return;
      }
      const baselineStillActive =
        ctx.sessionManager.getSessionId() === sessionId &&
        ctx.sessionManager.getBranch().some((entry) => entry.id === baselineLeafId);
      if (!baselineStillActive) {
        ctx.ui.notify(SESSION_CHANGED_NOTICE, "warning");
        return;
      }
      baselineLeafId = ctx.sessionManager.getLeafId();
      if (!isCurrentRequest()) return;
    }
    try {
      const targets = new Set(
        pending.entries
          .filter((entry) => ctx.sessionManager.getEntry(entry.sourceEntry.id))
          .map((entry) => entry.sourceEntry.id),
      );
      const replacement = createReplacement(
        ctx.sessionManager,
        pending.entries,
        targets,
        payload.handoff,
      );
      return {
        entries: [
          ...event.entries,
          ...pending.drafts,
          { type: "custom", customType: REPLACEMENT_STATE, data: replacement },
          ...replacementEdits(replacement),
          ...(replacement.anchorId === null
            ? [
                {
                  type: "custom_message" as const,
                  customType: "recontext-handoff",
                  content: replacement.content,
                  display: false,
                },
              ]
            : []),
          replacementCommitDraft(replacement),
          {
            type: "custom",
            customType: STATE_TYPE,
            data: { ...counterState(requiresApproval ? 0 : count + 1), requestId },
          },
        ],
        continue: true,
      };
    } catch (error) {
      ctx.ui.notify(`recontext: replacement failed (${errorMessage(error)})`, "error");
      return;
    }
  }
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

export function isHandoffPayload(value: unknown): value is HandoffPayload {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    typeof value.handoff === "string" &&
    value.handoff.trim().length > 0 &&
    (value.class === undefined ||
      (typeof value.class === "string" && value.class.trim().length > 0))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
