// Pure helpers for one-shot child runs: the parent-visible report settlement
// and the child session label. Mirrors pi's agents extension
// (`isFailedResult` / `sessionNameFor`) so delegated runs behave the same.

import type { ContentBlock } from "@deepseek-ai/dsh-llm";

/** Label cap shared with pi's `sessionNameFor`, counted in code points. */
export const SESSION_NAME_MAX_CHARS = 30;

/** Join the child's text blocks into the parent-visible report. */
export const contentToText = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

/**
 * pi-compatible child session label: `agent: <trimmed first task line>`,
 * truncated to 30 code points with an ellipsis. Falls back to the bare agent
 * name when the first line is empty.
 */
export function sessionNameFor(agentName: string, task: string): string {
  const firstLine = (task.split("\n", 1)[0] ?? "").trim();
  const chars = Array.from(firstLine);
  const summary =
    chars.length > SESSION_NAME_MAX_CHARS
      ? `${chars.slice(0, SESSION_NAME_MAX_CHARS).join("")}…`
      : chars.join("");
  return summary ? `${agentName}: ${summary}` : agentName;
}

export interface ChildRunOutcome {
  readonly stopReason: string;
  readonly diagnostic?: string;
  readonly output: readonly ContentBlock[];
}

/**
 * pi parity: a completed child whose final text is empty is a silent failure
 * (e.g. no model was ever assigned), reported as an error instead of a
 * `(no output)` success. Non-completed stop reasons remain errors.
 */
export function settleChildRun(
  result: ChildRunOutcome,
  childName: string,
): { ok: true; text: string } | { ok: false; message: string } {
  const text = contentToText(result.output);
  if (result.stopReason !== "completed" || text === "") {
    const detail = result.diagnostic ?? text;
    return {
      ok: false,
      message: `child ${childName} ${result.stopReason}: ${detail || "(no output)"}`,
    };
  }
  return { ok: true, text };
}
