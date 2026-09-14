/**
 * The durable session event as seen by the client half.
 *
 * The type literal, payload, and `SessionEventMap` merge mirror the host
 * entry (`src/index.ts`); the two literals are pinned equal by
 * `src/index.test.ts`. The client bundle inlines this module.
 */
import type { ZaiRetryWaitData } from "../index";

/** Log-only event type appended by the host at each retry-wait start. */
export const ZAI_RETRY_WAIT_EVENT_TYPE = "zai-concurrency-retry/wait";

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "zai-concurrency-retry/wait": ZaiRetryWaitData;
  }
}
