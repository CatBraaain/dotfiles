/** Browser client half: replace the sidebar's stock session browser with our
 * grouped list whose row actions archive the session or copy its id in one
 * click, and whose header adds workspaces through the sidebar's directory
 * flow. */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Slot registry service (`ctx.slots`) and the session-scope standard props
// (`useSessions` / `useSessionPendingInteraction`) / layout / locale augmentations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The `sessions` service declaration collides with the thin SessionStore one
// from @deepseek-ai/dsh-session (same cordis Context key), so read it through
// the full ISessions face explicitly.
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSessionList, type DirectoryFlowOwner } from './list'
import { DICT_EN, DICT_ZH, NS } from './locales'
import { LIST_CSS, registerSessionList } from './apply'

/** Services this client half touches. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'locale']

export function apply(ctx: Context): void {
  const sessions = ctx.sessions as unknown as ISessions
  const workspaces = ctx.workspaces
  const uiWorkspace = (ctx as unknown as {
    uiWorkspace: { startSession: (workspaceId?: string) => void }
  }).uiWorkspace
  const layout = ctx.layout

  ctx.locale.register(NS, 'en', DICT_EN)
  ctx.locale.register(NS, 'zh', DICT_ZH)

  const style = document.createElement('style')
  style.textContent = LIST_CSS
  ;(document.head ?? document.documentElement).appendChild(style)
  ctx.effect(() => () => style.remove(), 'session-list: style')

  registerSessionList(ctx, createSessionList({
    openSession: (id) => {
      sessions.open(id)
      layout.selectPanel(null)
    },
    archiveSession: (id) => {
      workspaces.archiveSession(id).catch((reason: unknown) => {
        console.warn('session-list: archive failed:', reason)
      })
    },
    createWorkspace: (input) => workspaces.create(input),
    startSession: (workspaceId) => {
      // Stock pick semantics: the created workspace's blank session opens.
      uiWorkspace.startSession(workspaceId)
    },
    renderDirectoryFlow: (owner: DirectoryFlowOwner): ReactNode => {
      // The directory-flow child hole is declared by the (shadowed but
      // alive) stock browser entry, so we render its live occupant directly
      // instead of through a renderSlot seat of our own.
      const entry = ctx.slots.entries('sidebar.workspaces.directoryFlow').at(0)
      if (entry?.component === undefined) return null
      const injected = (entry.inject?.() ?? {}) as Record<string, unknown>
      return createElement(entry.component as ComponentType<Record<string, unknown>>, {
        ...owner,
        ...injected,
      })
    },
  }))
}
