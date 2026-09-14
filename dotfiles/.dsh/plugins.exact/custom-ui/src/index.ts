// dotfiles-dsh-custom-ui — host half.
//
// Stamps the spec's default reasoning effort onto every model request whose
// selection carries no explicit effort: the highest advertised non-off level
// for the resolved route (see ./default-effort.ts and SPEC.md). Runs on the
// `agent/request` waterfall AFTER route resolution (this bundle loads before
// dotfiles-dsh-agents, whose route rewrite we observe through `next()`), so
// the effort always matches the route that actually serves the request.

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
    const base = await next();
    const info = await ctx.llm.resolveModelInfo(base.provider, base.model).catch(() => undefined);
    return withDefaultEffort(
      base,
      info?.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
      ReasoningEffortId,
    );
  });
}
