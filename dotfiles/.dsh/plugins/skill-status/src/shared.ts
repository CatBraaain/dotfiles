/**
 * Host/client shared literals for skill-status.
 *
 * The host entry imports this module directly; the client bundle inlines it
 * (the module is dependency-free, so inlining adds no bare specifier). One
 * source of truth replaces the former duplicate-and-pin contract between
 * `src/index.ts` and a client event module.
 */

/** Log-only event type appended by the host once per first successful skill use. */
export const SKILL_STATUS_EVENT_TYPE = 'skill-status/used'

/** Session-projection key publishing the first-use ordered used-skill names. */
export const SKILL_STATUS_PROJECTION_KEY = 'skillStatus'

/** Payload of {@link SKILL_STATUS_EVENT_TYPE}: the skill that was used. */
export interface SkillStatusUsedData {
    readonly name: string
}

declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'skill-status/used': SkillStatusUsedData
    }
}

/** Client-visible projection value: the used skill names in first-use order. */
export type SkillStatusProjectionView = readonly string[]

declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        skillStatus: SkillStatusProjectionView
    }
}

/** The name carried by one used-event payload, when it is a non-empty string. */
export function usedSkillName(data: unknown): string | undefined {
    const name = (data as { readonly name?: unknown } | undefined)?.name
    return typeof name === 'string' && name.length > 0 ? name : undefined
}
