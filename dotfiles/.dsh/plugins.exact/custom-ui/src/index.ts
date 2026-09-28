// dotfiles-dsh-custom-ui — host half.

import type { Context } from "@deepseek-ai/cordis";
// Type-only import pulls in the `declare module '@deepseek-ai/cordis'`
// augmentation typing the `agent/request` waterfall payload.
import type {} from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm/brand";
import { withDefaultEffort } from "./default-effort.ts";

export const name = "custom-ui";
export const inject = ["llm"];

export function apply(ctx: Context): void {
  ctx.on("agent/request", async (_payload, next) => {
    // This bundle loads before dotfiles-dsh-agents; next() returns its rewritten route.
    const base = await next();
    const info = await ctx.llm.resolveModelInfo(base.provider, base.model).catch(() => undefined);
    return withDefaultEffort(
      base,
      info?.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
      ReasoningEffortId,
    );
  });
}
