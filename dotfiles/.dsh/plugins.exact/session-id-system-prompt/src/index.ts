import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type { AssembleContext } from "@deepseek-ai/dsh-system-prompt";

export const name = "dsh-session-id-system-prompt";
export const inject = ["systemPrompt"];

const SECTION_NAME = "dotfiles:session-id";
const SECTION_ORDER = 50;

/** Render the current agent's durable dsh session identifier as prompt data. */
export function sessionIdPrompt({ agent }: AssembleContext): string {
  if (agent === undefined) return "";
  const sessionId = JSON.stringify(String(agent.session.id)).replaceAll(
    /[{}]/g,
    (brace) => `\\u${brace === "{" ? "007b" : "007d"}`,
  );
  return `Current dsh session ID: ${sessionId}`;
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: sessionIdPrompt,
  });
}
