/**
 * Title formatting primitives, kept pure for unit tests.
 *
 * The titlebar owns only a leading state mark; the rest of `document.title`
 * (`{session title} — {product title}`) stays owned by the stock
 * `DocumentTitle` component in `@deepseek-ai/dsh-client-ui-layout`. Marks are
 * recognized back out of the title this plugin last wrote, so the stock
 * component and this plugin never have to agree on the base string.
 */

/** Braille spinner frames cycled every {@link SPINNER_INTERVAL_MS} while the agent runs. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Spinner tick interval in milliseconds (pi parity). */
export const SPINNER_INTERVAL_MS = 100;

/** Static mark shown while the current session waits for user input. */
export const WAITING_MARK = "⏸";

/** Every mark character this plugin may have written, followed by one space. */
const MARKED_TITLE_PATTERN = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⏸] )/;

/** The spinner frame current at `nowMs`, cycling every {@link SPINNER_INTERVAL_MS}. */
export function spinnerFrame(nowMs: number, frames: readonly string[] = SPINNER_FRAMES): string {
  const index = Math.floor(nowMs / SPINNER_INTERVAL_MS) % frames.length;
  return frames[index < 0 ? index + frames.length : index]!;
}

/** Split a document title into this plugin's leading mark (if any) and the plain title. */
export function splitMarkedTitle(title: string): {
  readonly mark?: string;
  readonly plain: string;
} {
  const match = MARKED_TITLE_PATTERN.exec(title);
  if (match === null) return { plain: title };
  return { mark: match[0].trimEnd(), plain: title.slice(match[0].length) };
}

/** Compose the full document title from a state mark and the plain title. */
export function buildTitle(mark: string | undefined, plain: string): string {
  return mark === undefined ? plain : `${mark} ${plain}`;
}
