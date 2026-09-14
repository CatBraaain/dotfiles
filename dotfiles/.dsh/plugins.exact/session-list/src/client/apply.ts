/** Slot registration path, kept react-free: the component is passed through as an opaque value. */
import type { Context } from '@deepseek-ai/cordis'

/** List layout, mirroring the stock browser metrics (32px session rows, 34px group headers). */
export const LIST_CSS = [
  '.session-list-root{box-sizing:border-box;min-height:0;flex-direction:column;flex:1;display:flex}',
  '.session-list-header{flex:none;align-items:center;justify-content:space-between;height:36px;' +
    'padding-left:4px;margin:2px 8px 4px;display:flex;box-sizing:border-box;' +
    'color:var(--dsw-alias-label-tertiary)}',
  '.session-list-header-label{flex:none;overflow:hidden;white-space:nowrap;line-height:20px}',
  '.session-list-add{flex:none;display:inline-flex;justify-content:center;align-items:center;' +
    'width:28px;height:28px;border:none;border-radius:50%;padding:0;background:transparent;' +
    'cursor:pointer;color:var(--dsw-alias-label-secondary)}',
  '.session-list-add:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-list{min-height:0;flex-direction:column;flex:1;overflow-y:auto;margin:0 8px 8px;' +
    'padding-left:4px;display:flex;scrollbar-gutter:stable}',
  '.session-list-group{position:relative}',
  '.session-list-group+.session-list-group{margin-top:4px}',
  '.session-list-group>.session-list-row+*,.session-list-group>.session-list-overflow+*{margin-top:2px}',
  '.session-list-group-row{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);' +
    'border-radius:8px;align-items:center;gap:6px;height:34px;padding:0 8px;display:flex;box-sizing:border-box}',
  '.session-list-group-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-folder{width:16px;height:20px;flex:none;justify-content:center;align-items:center;' +
    'display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
  '.session-list-group-current .session-list-folder{color:var(--dsw-alias-state-business-primary)}',
  '.session-list-chevron{width:16px;height:20px;flex:none;justify-content:center;align-items:center;display:none}',
  '.session-list-group-row:hover .session-list-chevron{display:inline-flex}',
  '.session-list-group-row:hover .session-list-folder{display:none}',
  '.session-list-chevron svg{transition:transform 150ms var(--ds-ease-in-out)}',
  '.session-list-chevron .session-list-chevron-open{transform:rotate(90deg)}',
  '.session-list-group-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'font-size:14px;line-height:20px}',
  '.session-list-group-actions{flex:none;align-items:center;gap:10px;display:none}',
  '.session-list-group-row:hover .session-list-group-actions{display:inline-flex}',
  '.session-list-group-action{flex:none;display:inline-flex;justify-content:center;align-items:center;' +
    'width:28px;height:28px;border:none;border-radius:50%;padding:0;background:transparent;' +
    'cursor:pointer;color:var(--dsw-alias-label-secondary)}',
  '.session-list-group-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-overflow{width:100%;height:28px;border:none;border-radius:8px;padding:0 12px 0 28px;' +
    'background:transparent;cursor:pointer;text-align:left;font-size:12px;' +
    'color:var(--dsw-alias-label-tertiary)}',
  '.session-list-overflow:hover{background:transparent;color:var(--dsw-alias-label-secondary)}',
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
  '.session-list-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;' +
    'justify-content:center;padding:24px}',
  '.session-list-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);' +
    'backdrop-filter:var(--dsw-mask-blur)}',
  '.session-list-modal-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;' +
    'width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:24px;' +
    'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
  '.session-list-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
    'padding:22px 14px 12px 24px}',
  '.session-list-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;' +
    'color:var(--dsw-alias-label-primary)}',
  '.session-list-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;' +
    'width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;' +
    'color:var(--dsw-alias-label-secondary)}',
  '.session-list-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-modal-body{padding:0 24px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
  '.session-list-modal-error{color:var(--dsw-alias-label-primary);word-break:break-word}',
  '.session-list-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
  '.session-list-modal-action{display:inline-flex;align-items:center;justify-content:center;height:36px;' +
    'border:none;border-radius:18px;padding:0 14px;cursor:pointer;font-size:14px;line-height:22px;' +
    'color:var(--dsw-alias-label-primary);background:transparent}',
  '.session-list-modal-action:disabled{cursor:not-allowed;opacity:0.4}',
  '.session-list-modal-outline{border:0.5px solid var(--dsw-alias-border-l3)}',
  '.session-list-modal-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.session-list-modal-primary{background:var(--dsw-alias-button-primary-fill);' +
    'color:var(--dsw-alias-label-primary-foreground)}',
  '.session-list-modal-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
].join('')

/**
 * Shadowing rank for our registrant: one below the stock entry (which
 * registers without a priority, i.e. 0). The single slot renders its
 * lowest-priority registrant, so our list displaces the stock browser
 * without unregistering it. The directory-flow child hole stays owned by
 * the stock entry's declaration — re-declaring it here is a registry error
 * ("already declared"), so the add flow renders the hole's live occupant
 * directly through {@link directoryFlowElement} in index.ts.
 */
const SHADOW_PRIORITY = -1

/** Occupancy from the ledger entry count (extracted for direct testing). */
export function directoryFlowOccupied(entryCount: number): boolean {
  return entryCount > 0
}

/**
 * Occupancy of the sidebar's directory-flow hole (stock `flowSource`): true
 * while a picking occupant is registered, subscribed through the ledger.
 */
function directoryFlowSource(ctx: Context): {
  getSnapshot: () => boolean
  subscribe: (listener: () => void) => () => void
} {
  return {
    getSnapshot: () => directoryFlowOccupied(ctx.slots.entries('sidebar.workspaces.directoryFlow').length),
    subscribe: (listener) => ctx.slots.subscribe('sidebar.workspaces.directoryFlow', listener),
  }
}

/** Mount the list into the sidebar workspace slot (stock browser stays registered but unrendered). */
export function registerSessionList(ctx: Context, component: unknown): void {
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        priority: SHADOW_PRIORITY,
        locale: 'session-list',
        inject: () => ({
          hooks: { workspaces: ctx.workspaces.list, directoryFlow: directoryFlowSource(ctx) },
        }),
      },
      component,
    ),
  )
}
