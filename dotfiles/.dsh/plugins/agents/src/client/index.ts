/** Browser client half: show the live agents.yaml agent and class under the composer. */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Context augmentation: the `ctx.slots` registry service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// SlotMap augmentation: 'conversation.composer.dock' is a session-scope list.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerAgentClassDisplay } from './apply'
import { startStatePoller } from './controller'
import { agentStateLines, type AgentDisplayState } from './format'
import { createStateFetcher } from './state.ts'

/** Services this client half touches (the slot registry only). */
export const inject = ['slots']

/** Poll cadence; the display follows host-side switches within this delay. */
const POLL_INTERVAL_MS = 2000

/** Dim secondary text matching the neighboring session-id footer row. */
const DISPLAY_STYLE: Readonly<Record<string, string>> = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
}

interface DisplayProps {
  readonly sessionId: SessionId
  readonly fetchState: (sessionId: SessionId) => Promise<AgentDisplayState>
}

function AgentClassDisplay({ sessionId, fetchState }: DisplayProps): ReactNode {
  const [state, setState] = useState<AgentDisplayState>({ managed: false })
  useEffect(
    () =>
      startStatePoller(POLL_INTERVAL_MS, {
        fetchState: () => fetchState(sessionId),
        onState: setState,
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      }),
    [sessionId, fetchState],
  )

  const lines = agentStateLines(state)
  if (lines.length === 0) return null
  return createElement(
    'div',
    { style: DISPLAY_STYLE },
    ...lines.map((line) => createElement('div', { key: line }, line)),
  )
}

/** Wire the display into the composer dock (registration path lives in ./apply). */
export function apply(ctx: Context): void {
  const fetchState = createStateFetcher(globalThis.fetch)
  const component: unknown = (props: DisplayProps) =>
    createElement(AgentClassDisplay, { ...props, fetchState })
  registerAgentClassDisplay(ctx, component)
}
