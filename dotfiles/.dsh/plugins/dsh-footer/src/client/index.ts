/** Browser client half: keep the current session id visible under the composer. */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Context augmentation: the `ctx.slots` registry service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// SlotMap augmentation: 'conversation.composer.dock' is a session-scope list.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatSessionLabel } from './format'
import { registerSessionIdFooter } from './apply'

/** Services this client half touches (the slot registry only). */
export const inject = ['slots']

/**
 * The session-scope standard props this component consumes. The runtime hands
 * every session-scope slot component the current `sessionId` (plus hooks this
 * entry does not read), so no host-side wiring exists.
 */
interface SessionIdFooterProps {
  readonly sessionId: SessionId
}

/** Dim secondary text matching the neighboring StatsPills row. */
const FOOTER_STYLE: Readonly<Record<string, string>> = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
}

function SessionIdFooter({ sessionId }: SessionIdFooterProps): ReactNode {
  return createElement('div', { style: FOOTER_STYLE }, formatSessionLabel(sessionId))
}

/** Wire the footer entry into the composer dock (registration path lives in ./apply). */
export function apply(ctx: Context): void {
  registerSessionIdFooter(ctx, SessionIdFooter)
}
