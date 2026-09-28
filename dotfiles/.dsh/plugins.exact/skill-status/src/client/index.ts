import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
// Context augmentation: the `ctx.slots` registry service.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
// SessionStandardProps augmentation: session-scope slot props carry `useProjection`.
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { UseProjection } from "@deepseek-ai/dsh-api-session-controller/client";
import { SKILL_STATUS_PROJECTION_KEY } from "../shared";
import { registerSkillStatusDock } from "./apply";
import { buildSkillStatusLine } from "./format";

/** Services this client half touches. */
export const inject = ["slots"];

/**
 * Gray secondary text matching the neighboring stock rows (repo gray policy).
 * Width follows the first-party input.dock convention (TodoPanel/GoalBar):
 * a centered band narrower than the composer card, so the ellipsis has a
 * bounded box instead of stretching to the full dock width.
 */
const STATUS_STYLE: Readonly<Record<string, string>> = {
  boxSizing: "border-box",
  width: "calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)",
  maxWidth: "calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)",
  margin: "0 auto",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "var(--dsh-content-font-size-secondary, 13px)",
  lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** The dock row: the label-only line before any skill completes, names after. */
function SkillStatusRow({ useProjection }: { readonly useProjection: UseProjection }): ReactNode {
  // The follow opening seeds the whole projection; later frames update it without reading the event window.
  const names = useProjection(SKILL_STATUS_PROJECTION_KEY);
  return createElement("div", { style: STATUS_STYLE }, buildSkillStatusLine(names ?? []));
}

/** Wire the dock entry. */
export function apply(ctx: Context): void {
  registerSkillStatusDock(ctx, SkillStatusRow);
}
