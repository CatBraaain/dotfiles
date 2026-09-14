/**
 * React half of the flat session list: one row per visible host row, status
 * dot + title + relative time, current highlight, and one-click row actions
 * (archive / copy session id). Row derivation lives in ./rows.
 */
import { createElement, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot, WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconArchiveOutline20,
  IconCheckOutline16,
  IconCopyOutline16,
  StateDot,
  relativeTime,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { dotState, ensureCurrentBlank, rowTitle, timeLabel, visibleRows, type RowListSource, type RowSummary } from './rows'

/** How long the check icon stays before reverting to the copy icon. */
const COPIED_RESET_MS = 1000
/** How often relative-time labels refresh. */
const NOW_TICK_MS = 30_000

/** Host actions the list drives (wired from the apply closure). */
export interface SessionListDeps {
  openSession: (id: SessionId) => void
  archiveSession: (id: SessionId) => void
}

/** Selector-hook face of the renderer's standard and injected props (structural). */
type SelectorHook<Snapshot> = <Selected>(selector: (snapshot: Snapshot) => Selected) => Selected

/**
 * Component props, written structurally (the stock composition's SlotMap
 * augmentation is not resolvable from a plugin build): the sidebar shell's
 * owner share (`wide` / `expandSidebar`), the renderer's global standard props
 * (`useSessions` / `useSessionPendingInteraction`), our injected hooks
 * (`useWorkspaces`), and the `t` seat of the declared locale namespace.
 */
export interface SessionListProps {
  readonly wide: boolean
  readonly expandSidebar: () => void
  readonly useSessions: SelectorHook<SessionListState>
  readonly useSessionPendingInteraction: SelectorHook<SessionPendingInteractionSnapshot>
  readonly useWorkspaces: SelectorHook<WorkspaceSnapshot>
  readonly t: Translate
}

/** Adapt the host list snapshot (branded keys) to the pure derivation input. */
function rowSource(state: SessionListState): RowListSource {
  const byId: Record<string, RowSummary | undefined> = {}
  for (const [id, summary] of Object.entries(state.byId)) byId[id] = summary
  return { ids: state.ids, byId, current: state.current }
}

/** Build the list component over the given host actions. */
export function createSessionList(deps: SessionListDeps): (props: SessionListProps) => ReactNode {
  return function SessionList(props: SessionListProps): ReactNode {
    const list = props.useSessions((s) => s)
    const pending = props.useSessionPendingInteraction((s) => s)
    const workspaces = props.useWorkspaces((s) => s)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
      return () => clearInterval(timer)
    }, [])

    const source = rowSource(list)
    const rows = ensureCurrentBlank(visibleRows(source, workspaces.archivedSessionIds), source)
    return createElement(
      'div',
      { className: props.wide ? 'session-list-root' : 'session-list-root session-list-rail' },
      createElement(
        'div',
        { className: 'session-list-list', role: 'tree', 'aria-label': 'Sessions' },
        rows.map((row) =>
          createElement(SessionRow, {
            key: row.id,
            row,
            selected: list.current === row.id,
            hasPending: pending.has(row.id as SessionId),
            wide: props.wide,
            now,
            t: props.t,
            open: deps.openSession,
            archive: deps.archiveSession,
          }),
        ),
      ),
    )
  }
}

interface RowProps {
  readonly row: RowSummary
  readonly selected: boolean
  readonly hasPending: boolean
  readonly wide: boolean
  readonly now: number
  readonly t: Translate
  readonly open: (id: SessionId) => void
  readonly archive: (id: SessionId) => void
}

/** One flat session row: status dot, title, relative time, hover actions. */
function SessionRow(props: RowProps): ReactNode {
  const { row, selected, hasPending, wide, now, t } = props
  const [copied, setCopied] = useState(false)
  /** Non-null while the copied flag is showing; doubles as the re-click guard. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the pending revert when the row unmounts (session archive).
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  const onCopy = (): void => {
    if (timerRef.current !== null) return
    void writeClipboard(row.id).then((ok) => {
      if (!ok || timerRef.current !== null) return
      setCopied(true)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setCopied(false)
      }, COPIED_RESET_MS)
    })
  }

  const classes = ['session-list-row']
  if (selected) classes.push('session-list-selected')
  const children: ReactNode[] = [
    createElement(
      'span',
      { key: 'slot', className: 'session-list-slot' },
      createElement(StateDot, { state: dotState(row, hasPending) }),
    ),
  ]

  if (wide) {
    children.push(createElement('span', { key: 'title', className: 'session-list-title' }, rowTitle(row, t('session.new'))))
    if (!row.blank) {
      children.push(
        createElement(
          'span',
          { key: 'time', className: 'session-list-time' },
          timeLabel(relativeTime(row.updatedAt, now), t),
        ),
        createElement(
          'span',
          { key: 'actions', className: 'session-list-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'session-list-action',
              title: t('actions.archive'),
              onClick: (event: MouseEvent<HTMLElement>) => {
                event.stopPropagation()
                props.archive(row.id as SessionId)
              },
            },
            createElement(IconArchiveOutline20, { size: 16 }),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'session-list-action',
              title: t('actions.copyId'),
              onClick: (event: MouseEvent<HTMLElement>) => {
                event.stopPropagation()
                onCopy()
              },
            },
            createElement(copied ? IconCheckOutline16 : IconCopyOutline16),
          ),
        ),
      )
    }
  }

  return createElement(
    'div',
    {
      className: classes.join(' '),
      role: 'treeitem',
      'aria-selected': selected,
      onClick: () => props.open(row.id as SessionId),
    },
    ...children,
  )
}
