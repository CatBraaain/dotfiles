/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from "@deepseek-ai/cordis";

/** Mount the agent/class display into the composer dock (after the session-id footer). */
export function registerAgentClassDisplay(ctx: Context, component: unknown): void {
  ctx.slots.inject("conversation.composer.dock", () =>
    ctx.slots.register(
      { name: "conversation.composer.dock", id: "agent-class", order: 2 },
      component,
    ),
  );
}
