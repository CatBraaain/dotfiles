/** Build the visible status line for the used-skill names. */

/**
 * The display line. The label stays visible even with no used skill, so the
 * row announces itself before the first skill completes.
 */
export function buildSkillStatusLine(names: readonly string[]): string {
  return `🎯 skills: ${names.join(", ")}`;
}
