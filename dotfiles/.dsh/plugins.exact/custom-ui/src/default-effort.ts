/**
 * Default reasoning-effort rule (SPEC.md「既定 effort とフォールバック」):
 * with no explicit selection, send the highest advertised non-off level;
 * when only "off" is advertised, send no effort at all.
 *
 * Pure logic — no dsh imports, so the unit test stays dependency-free.
 */

/** pi-ai's thinking levels, ascending. `off` exists but is never auto-picked. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Level = (typeof LEVELS)[number];

/**
 * The highest advertised level above `off`, or undefined when the model
 * advertises nothing selectable (non-reasoning model).
 */
export function defaultEffortOf(advertised: readonly string[]): Level | undefined {
  for (let i = LEVELS.length - 1; i > 0; i--) {
    if (advertised.includes(LEVELS[i])) return LEVELS[i];
  }
  return undefined;
}

/**
 * The call config to send: an explicit selection passes through untouched;
 * otherwise the model's default effort is stamped on. Absence of a default
 * keeps the base config (the provider's own behavior). The picked level is
 * passed through `toEffort` (the host maps it to the branded effort id).
 */
export function withDefaultEffort<T extends object>(
  base: T,
  advertised: readonly string[],
  toEffort: (level: Level) => unknown,
): T {
  const selected = base as { reasoningEffort?: unknown };
  if (selected.reasoningEffort !== undefined) return base;
  const level = defaultEffortOf(advertised);
  if (level === undefined) return base;
  return { ...base, reasoningEffort: toEffort(level) };
}
