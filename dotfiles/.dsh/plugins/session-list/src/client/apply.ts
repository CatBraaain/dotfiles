/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from '@deepseek-ai/cordis'

/** List layout, mirroring the stock row metrics (32px rows, hover fill). */
export const LIST_CSS = [
  '.session-list-root{box-sizing:border-box;min-height:0;flex-direction:column;flex:1;display:flex}',
  '.session-list-list{min-height:0;flex-direction:column;flex:1;overflow-y:auto;margin:0 8px 8px;' +
    'padding-left:4px;display:flex;scrollbar-gutter:stable}',
  '.session-list-row{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);' +
    'border-radius:8px;align-items:center;height:32px;padding:0 8px;display:flex}',
  '.session-list-row:hover,.session-list-row.session-list-selected{background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-slot{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:inline-flex}',
  '.session-list-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'font-size:14px;line-height:20px;margin:0 6px 0 4px}',
  '.session-list-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap}',
  '.session-list-actions{flex:none;align-items:center;gap:10px;display:none}',
  '.session-list-row:hover .session-list-actions{display:inline-flex}',
  '.session-list-row:hover .session-list-time{display:none}',
  '.session-list-action{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);' +
    'background:none;border:none;border-radius:4px;padding:0;display:inline-flex;justify-content:center;align-items:center}',
  '.session-list-action:hover{color:var(--dsw-alias-label-primary)}',
  '.session-list-rail .session-list-row{height:32px;justify-content:center;padding:0}',
].join('')

/**
 * Shadowing rank for our registrant: one below the stock entry (which
 * registers without a priority, i.e. 0). The single slot renders its
 * lowest-priority registrant, so our flat list displaces the stock browser
 * without unregistering it.
 */
const SHADOW_PRIORITY = -1

/** Mount the flat list into the sidebar workspace slot (stock browser stays registered but unrendered). */
export function registerSessionList(ctx: Context, component: unknown): void {
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        priority: SHADOW_PRIORITY,
        locale: 'session-list',
        inject: () => ({ hooks: { workspaces: ctx.workspaces.list } }),
      },
      component,
    ),
  )
}
