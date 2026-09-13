/**
 * Browser client half: keep the used-skill names visible above the composer.
 *
 * Registers (1) the Conversation Definition/view target that fold
 * `skill-status/used` events — history included — into a names snapshot, and
 * (2) one `conversation.input.dock` entry rendering that snapshot as
 * `🎯 skills: ...` in gray, clipped with an ellipsis, hidden while empty.
 */
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Context augmentation: the `ctx.slots` registry service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// SlotMap + ConversationViewSnapshotMap augmentations and `ctx.uiConversation`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { registerSkillStatusConversation } from './conversation'
import { registerSkillStatusDock } from './apply'
import type { SkillStatusSource } from './source'
import { buildSkillStatusLine } from './format'

/** Services this client half touches. */
export const inject = ['slots', 'uiConversation']

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
function SkillStatusRow({ source }: { readonly source: SkillStatusSource }): ReactNode {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const line = buildSkillStatusLine(snapshot.names)
    if (line === undefined) return null
    return createElement('div', { style: STATUS_STYLE }, line)
}

/** Wire the Conversation assembly and the dock entry. */
export function apply(ctx: Context): void {
    registerSkillStatusConversation(ctx)
    registerSkillStatusDock(ctx, SkillStatusRow)
}
