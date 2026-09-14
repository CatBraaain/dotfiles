/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from "@deepseek-ai/cordis";

/** Class the triggers carry; the injected sheet hangs the hover fill on it. */
export const TRIGGER_CLASS = "dotfiles-agents-trigger";

/**
 * Sheet applied by `apply` (see index.ts): the stock interactive hover fill
 * for the row triggers. Pseudo-classes cannot live in inline style, and the
 * primitives Menu wraps each trigger in its own inline-flex span, so the
 * reset and the `:hover` both ride the class above through this injected
 * sheet (an inline `background: none` would beat the hover rule).
 */
export const AGENTS_TRIGGER_CSS = `
.${TRIGGER_CLASS} {
  background: none;
}
.${TRIGGER_CLASS}:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
`;

/** Mount the agent/class display above the composer card (after the quota line). */
export function registerAgentClassDisplay(ctx: Context, component: unknown): void {
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      { name: "conversation.input.dock", id: "agent-class", order: 2 },
      component,
    ),
  );
}
