/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from "@deepseek-ai/cordis";

/** Mount the agent/class display above the composer card (after the quota line). */
export function registerAgentClassDisplay(ctx: Context, component: unknown): void {
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      { name: "conversation.input.dock", id: "agent-class", order: 2 },
      component,
    ),
  );
}
