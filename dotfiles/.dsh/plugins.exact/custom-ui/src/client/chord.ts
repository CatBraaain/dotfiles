/**
 * Ctrl+K → Ctrl+M chord state machine (SPEC.md「Ctrl+K → Ctrl+M でモデル選択」).
 * Pure logic: the DOM keydown handler in index.ts only translates events and
 * applies the returned swallow/open decisions.
 */

/** How long the Ctrl+K chord stays armed, in ms (SPEC.md: 1 second). */
export const CHORD_TIMEOUT_MS = 1000;

export interface ChordMods {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface ChordEvent extends ChordMods {
  readonly key: string;
}

export interface ChordState {
  readonly armedAt?: number;
}

export interface ChordResult {
  readonly state: ChordState;
  /** The chord completed and the popup should open. */
  readonly open: boolean;
  /** The event must be kept away from the editor (Ctrl+K alone does nothing visible). */
  readonly swallow: boolean;
}

function plainCtrlOnly(event: ChordEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function isCtrlK(event: ChordEvent): boolean {
  return event.key === "k" && plainCtrlOnly(event);
}

function isCtrlM(event: ChordEvent): boolean {
  return event.key === "m" && plainCtrlOnly(event);
}

/**
 * Fold one keydown into the chord state. A Ctrl+K (re)arms for 1s; any other
 * key while armed disarms — it completes the chord only when it is Ctrl+M
 * within the window. Exactly CHORD_TIMEOUT_MS elapsed still counts (strictly
 * beyond it is a timeout), matching the spec's "1 秒以内".
 */
export function onChordKey(state: ChordState, event: ChordEvent, now: number): ChordResult {
  if (isCtrlK(event)) {
    return { state: { armedAt: now }, open: false, swallow: true };
  }
  if (state.armedAt === undefined) return { state, open: false, swallow: false };
  if (now - state.armedAt > CHORD_TIMEOUT_MS) return { state: {}, open: false, swallow: false };
  if (isCtrlM(event)) return { state: {}, open: true, swallow: true };
  return { state: {}, open: false, swallow: false };
}
