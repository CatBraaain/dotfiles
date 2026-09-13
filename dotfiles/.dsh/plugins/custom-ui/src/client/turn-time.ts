/** Pure helpers behind the custom turn-time tail: stock TurnTimePanel with the usage panel stripped. */

/** The two event bounds the stock panel reads off a TurnLocation. */
export interface TurnTimeSource {
  readonly start?: { readonly time: number } | undefined;
  readonly end?: { readonly time: number } | undefined;
}

/**
 * Turn wall-clock duration in milliseconds, matching the stock rule:
 * end minus start, clamped at zero, undefined while either bound is absent
 * (an open or unresolved turn).
 */
export function turnRunMs(turn: TurnTimeSource): number | undefined {
  if (turn.start === undefined || turn.end === undefined) return undefined;
  return Math.max(0, turn.end.time - turn.start.time);
}

/** Duration text: "45s" under a minute, then "1m 05s" with a zero-padded second field. */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
