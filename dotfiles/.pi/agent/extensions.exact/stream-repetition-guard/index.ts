import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rgbColor, Text } from "@earendil-works/pi-tui";
import { createRepetitionDetector, type RepetitionMatch } from "./detector.ts";

type BlockKind = "text" | "thinking" | "toolcall";
type Block = { kind: BlockKind; detector: ReturnType<typeof createRepetitionDetector> };

export default function streamRepetitionGuard(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ reason: string }>(
    "stream-repetition-guard",
    (entry, _options, theme) => {
      if (!entry.data?.reason) return;
      return new Text(theme.style(entry.data.reason, { fg: rgbColor(128, 128, 128) }), 0, 0);
    },
  );

  let enabled = false;
  let responseNumber = 0;
  let responseTimestamp: number | undefined;
  const blocks = new Map<number, Block>();
  const closedBlocks = new Set<number>();
  let stopped: { reason: string; responseTimestamp: number | undefined } | undefined;

  function reset(): void {
    enabled = false;
    responseNumber = 0;
    responseTimestamp = undefined;
    blocks.clear();
    closedBlocks.clear();
    stopped = undefined;
  }

  function stop(
    kind: BlockKind,
    contentIndex: number,
    match: RepetitionMatch,
    ctx: ExtensionContext,
  ): void {
    if (stopped) return;
    const reason = `stream-repetition-guard: aborted repeated ${kind} block ${contentIndex}; period=${match.period}, repetitions=${match.repetitions}, repeatedCharacters=${match.repeatedCharacters}, endPosition=${match.endPosition}`;
    stopped = { reason, responseTimestamp };
    blocks.clear();
    // The SDK context abort is fire-and-forget; awaiting session.abort here would deadlock event dispatch.
    ctx.abort();
    pi.appendEntry("stream-repetition-guard", {
      sessionId: ctx.sessionManager.getSessionId(),
      responseNumber,
      responseTimestamp,
      kind,
      contentIndex,
      ...match,
      reason,
    });
  }

  function finishBlock(contentIndex: number, ctx: ExtensionContext): void {
    const block = blocks.get(contentIndex);
    if (!block) return;
    const match = block.detector.finish();
    blocks.delete(contentIndex);
    closedBlocks.add(contentIndex);
    if (match) stop(block.kind, contentIndex, match, ctx);
  }

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("before_agent_start", () => {
    reset();
    enabled = true;
  });
  pi.on("message_start", (event) => {
    if (!enabled || stopped || event.message.role !== "assistant") return;
    responseNumber++;
    responseTimestamp = event.message.timestamp;
    blocks.clear();
    closedBlocks.clear();
  });
  pi.on("message_update", (event, ctx) => {
    if (!enabled || stopped || event.message.role !== "assistant") return;
    if (event.message.timestamp !== responseTimestamp) return;
    const update = event.assistantMessageEvent;
    if (
      update.type === "text_end" ||
      update.type === "thinking_end" ||
      update.type === "toolcall_end"
    ) {
      finishBlock(update.contentIndex, ctx);
      return;
    }
    if (
      update.type !== "text_delta" &&
      update.type !== "thinking_delta" &&
      update.type !== "toolcall_delta"
    )
      return;
    if (closedBlocks.has(update.contentIndex)) return;
    const kind =
      update.type === "text_delta"
        ? "text"
        : update.type === "thinking_delta"
          ? "thinking"
          : "toolcall";
    let block = blocks.get(update.contentIndex);
    if (!block) {
      block = { kind, detector: createRepetitionDetector() };
      blocks.set(update.contentIndex, block);
    }
    const match = block.detector.push(update.delta);
    if (match) stop(block.kind, update.contentIndex, match, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (!enabled || event.message.role !== "assistant") return;
    if (event.message.timestamp !== responseTimestamp) return;
    if (!stopped) {
      for (const contentIndex of blocks.keys()) {
        finishBlock(contentIndex, ctx);
        if (stopped) break;
      }
    }
    blocks.clear();
    if (!stopped) {
      responseTimestamp = undefined;
      return;
    }
    if (event.message.timestamp !== stopped.responseTimestamp) return;
    const originalError = event.message.errorMessage;
    if (event.message.stopReason === "aborted" && originalError?.includes(stopped.reason)) return;
    return {
      message: {
        ...event.message,
        stopReason: "aborted",
        errorMessage: originalError ? `${originalError}\n${stopped.reason}` : stopped.reason,
      },
    };
  });
  pi.on("tool_call", () => {
    if (stopped) return { block: true, reason: stopped.reason };
  });
}
