/** Slot registration path, kept react-free: the component passes through opaque. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'

/** Mount the status row into the dock above the composer card. */
export function registerSkillStatusDock(
    ctx: Context,
    component: (props: { readonly useProjection: UseProjection }) => unknown,
): void {
    ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
            {
                name: 'conversation.input.dock',
                id: 'skill-status',
                order: 10,
            },
            component,
        ))
}
