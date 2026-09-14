/** Build the visible transcript line for one concurrency-limit retry wait. */
import type { ZaiRetryWaitData } from "../index";

/** The static one-line notice; no live countdown (seconds are ceil'ed, matching the host log). */
export function buildRetryWaitLine(data: ZaiRetryWaitData): string {
  return `zai concurrency limit — retrying in ${Math.ceil(data.waitMs / 1000)}s (attempt ${data.attempt})`;
}
