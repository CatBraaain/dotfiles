/**
 * Host/client shared literals for skill-status.
 *
 * The host entry imports this module directly; the client bundle inlines it
 * (the module is dependency-free, so inlining adds no bare specifier). One
 * source of truth replaces the former duplicate-and-pin contract between
 * `src/index.ts` and a client event module.
 *
 * The plugin writes no session events of its own: the projection folds the
 * stock `tool/call` / `tool/result` events only, so session logs stay
 * readable by any harness build (see SPEC.md).
 */

/** Session-projection key publishing the first-use ordered used-skill names. */
export const SKILL_STATUS_PROJECTION_KEY = "skillStatus";

/** Client-visible projection value: the used skill names in first-use order. */
export type SkillStatusProjectionView = readonly string[];

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    skillStatus: SkillStatusProjectionView;
  }
}
