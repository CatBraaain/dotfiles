/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from "@deepseek-ai/cordis";

/** Mount the footer entry into the composer dock (after the stock StatsPills row). */
export function registerSessionIdFooter(ctx: Context, component: unknown): void {
  ctx.slots.inject("conversation.composer.dock", () =>
    ctx.slots.register(
      { name: "conversation.composer.dock", id: "session-id", order: 1 },
      component,
    ),
  );
}
