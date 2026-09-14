/** Browser client half: replace the sidebar's stock session browser with a flat
 * list whose row actions archive the session or copy its id in one click. */
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
import { createSessionList } from './list'
import { DICT_EN, DICT_ZH, NS } from './locales'
import { LIST_CSS, registerSessionList } from './apply'

/** Services this client half touches. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout', 'locale']

export function apply(ctx: Context): void {
  const sessions = ctx.sessions as unknown as ISessions
  const workspaces = ctx.workspaces
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
  }))
}
