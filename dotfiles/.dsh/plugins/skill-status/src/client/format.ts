/** Build the visible status line for the used-skill names. */

/** The display line, or undefined when no skill has been used yet. */
export function buildSkillStatusLine(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `🎯 skills: ${names.join(", ")}`;
}
