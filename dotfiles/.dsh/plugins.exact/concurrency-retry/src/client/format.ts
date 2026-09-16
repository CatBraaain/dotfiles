/** Build the visible transcript line for one concurrency-limit retry wait. */
import type { ConcurrencyRetryWaitData } from "../index";

/** The static one-line notice; seconds are rounded up to match the host log. */
export function buildRetryWaitLine(data: ConcurrencyRetryWaitData): string {
  return `${data.provider} concurrency limit — retrying in ${Math.ceil(data.waitMs / 1000)}s (attempt ${data.attempt})`;
}
