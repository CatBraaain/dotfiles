/**
 * The durable session event as seen by the client half.
 *
 * The type literal, payload, and `SessionEventMap` merge mirror the host
 * entry (`src/index.ts`); the two constants are pinned equal by
 * `src/index.test.ts`. The client bundle inlines this module.
 */
import type { SkillStatusUsedData } from '../index'

/** Log-only event type appended by the host once per first successful skill use. */
export const SKILL_STATUS_EVENT_TYPE = 'skill-status/used'

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'skill-status/used': SkillStatusUsedData
    }
}
