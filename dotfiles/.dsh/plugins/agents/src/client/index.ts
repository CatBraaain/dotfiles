/** Browser client half: show the live agents.yaml agent and class under the composer. */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Client Connection service: `ConnectionHandle` (ctx key `connection`, no
// cordis augmentation on the client half — read it through `ctx.get`).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Context augmentation: the `ctx.slots` registry service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// SlotMap augmentation: 'conversation.composer.dock' is a session-scope list.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// SessionStandardProps augmentation: session-scope slot props carry `sessionId`.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AGENTS_STATE_ENDPOINT } from '../state-rpc.ts'
import { registerAgentClassDisplay } from './apply'
import { startStatePoller } from './controller'
import { agentStateLines, parseDisplayState, type AgentDisplayState } from './format'

/** Services this client half touches (the slot registry and the RPC caller). */
export const inject = ['slots', 'connection']

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
  const connection = ctx.get?.('connection') as ConnectionHandle | undefined
  const fetchState = async (sessionId: SessionId): Promise<AgentDisplayState> => {
    if (!connection) return { managed: false }
    const result = await connection.rpc.call('/api', AGENTS_STATE_ENDPOINT, { sessionId })
    if (!result.ok) return { managed: false }
    return parseDisplayState(result.value)
  }
  const component: unknown = (props: DisplayProps) =>
    createElement(AgentClassDisplay, { ...props, fetchState })
  registerAgentClassDisplay(ctx, component)
}
