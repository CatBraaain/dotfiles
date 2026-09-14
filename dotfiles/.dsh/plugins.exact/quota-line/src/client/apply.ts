/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from "@deepseek-ai/cordis";

/** Mount the quota line above the composer card (before the stock TodoPanel row). */
export function registerQuotaLine(ctx: Context, component: unknown): void {
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register({ name: "conversation.input.dock", id: "quota-line", order: 1 }, component),
  );
}
