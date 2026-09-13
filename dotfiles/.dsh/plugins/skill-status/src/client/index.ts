/**
 * Browser client half: keep the used-skill names visible above the composer.
 *
 * Registers one `conversation.input.dock` entry rendering the host-computed
 * `skillStatus` session projection as `🎯 skills: ...` in gray, clipped with
 * an ellipsis, hidden while empty. The projection arrives through the
 * standard `useProjection` seat (whole value seeded by the follow opening and
 * pushed by projection frames), so the display restores from the host's
 * whole-log fold and never depends on the loaded event window.
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Context augmentation: the `ctx.slots` registry service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// SessionStandardProps augmentation: session-scope slot props carry `useProjection`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { SKILL_STATUS_PROJECTION_KEY } from '../shared'
import { registerSkillStatusDock } from './apply'
import { buildSkillStatusLine } from './format'

/** Services this client half touches. */
export const inject = ['slots']

/**
 * Gray secondary text matching the neighboring stock rows (repo gray policy).
 * Width follows the first-party input.dock convention (TodoPanel/GoalBar):
 * a centered band narrower than the composer card, so the ellipsis has a
 * bounded box instead of stretching to the full dock width.
 */
const STATUS_STYLE: Readonly<Record<string, string>> = {
    boxSizing: 'border-box',
    width: 'calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)',
    maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)',
    margin: '0 auto',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
}

/** The dock row: nothing while no skill has been used, the line otherwise. */
function SkillStatusRow({ useProjection }: { readonly useProjection: UseProjection }): ReactNode {
    const names = useProjection(SKILL_STATUS_PROJECTION_KEY)
    const line = buildSkillStatusLine(names ?? [])
    if (line === undefined) return null
    return createElement('div', { style: STATUS_STYLE }, line)
}

/** Wire the dock entry. */
export function apply(ctx: Context): void {
    registerSkillStatusDock(ctx, SkillStatusRow)
}
