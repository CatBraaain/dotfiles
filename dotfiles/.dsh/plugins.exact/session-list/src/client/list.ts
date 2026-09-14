/**
 * React half of the sidebar session list. Wide state renders the stock-style
 * workspace grouping: a section header (label + Add workspace), one group per
 * host workspace with a foldable header row and hover New Session action,
 * Show-more overflow folding, and the directory-pick add flow with its error
 * dialog. Rail state keeps the
 * flat icon column. Row derivation lives in ./rows.
 */
import {
  createElement, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconArchiveOutline20,
  IconCheckOutline16,
  IconCloseFill14,
  IconCopyOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconProjectAddOutline16,
  IconTriangleRightFill14,
  StateDot,
  relativeTime,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  collapsedSessionRows,
  deriveGroups,
  dotState,
  rowTitle,
  timeLabel,
  visibleRows,
  type RowListSource,
  type RowSummary,
  type SessionGroup,
} from './rows'

/** How long the check icon stays before reverting to the copy icon. */
const COPIED_RESET_MS = 1000
/** How often relative-time labels refresh. */
const NOW_TICK_MS = 30_000

/** Host actions the list drives (wired from the apply closure). */
export interface SessionListDeps {
  openSession: (id: SessionId) => void
  archiveSession: (id: SessionId) => void
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<{ workspaceId: WorkspaceId }>
  /** Open the created workspace's blank New Session (stock pick semantics). */
  startSession: (workspaceId: WorkspaceId) => void
  /** Render the sidebar directory-flow hole's live occupant with the owner conversation. */
  renderDirectoryFlow: (owner: DirectoryFlowOwner) => ReactNode
}

/** Owner share of the directory-flow hole (structural stock face). */
export interface DirectoryFlowOwner {
  readonly open: boolean
  readonly busy: boolean
  readonly onPicked: (path: string) => void
  readonly onCancel: () => void
  readonly onError: (message: string) => void
}

/** Selector-hook face of the renderer's standard and injected props (structural). */
type SelectorHook<Snapshot> = <Selected>(selector: (snapshot: Snapshot) => Selected) => Selected

/**
 * Component props, written structurally (the stock composition's SlotMap
 * augmentation is not resolvable from a plugin build): the sidebar shell's
 * owner share (`wide` / `expandSidebar`), the renderer's global standard props
 * (`useSessions` / `useSessionPendingInteraction` / `useWorkspaces`), our
 * injected hooks (`useDirectoryFlow`), and the `t` seat of the declared
 * locale namespace.
 */
export interface SessionListProps {
  readonly wide: boolean
  readonly expandSidebar: () => void
  readonly useSessions: SelectorHook<SessionListState>
  readonly useSessionPendingInteraction: SelectorHook<SessionPendingInteractionSnapshot>
  readonly useWorkspaces: SelectorHook<WorkspaceSnapshot>
  readonly useDirectoryFlow: SelectorHook<boolean>
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
    const flowAvailable = props.useDirectoryFlow((occupied) => occupied)
    const [now, setNow] = useState(() => Date.now())
    /** Folded workspace groups (stock keeps groups open by default). */
    const [collapsedKeys, setCollapsedKeys] = useState<string[]>([])
    /** Groups whose Show-more overflow the user expanded. */
    const [overflowKeys, setOverflowKeys] = useState<string[]>([])
    // Add-flow local state (stock WorkspacePickFlow add-only route).
    const [flowOpen, setFlowOpen] = useState(false)
    const [pickingFolder, setPickingFolder] = useState(false)
    const [errorOpen, setErrorOpen] = useState(false)
    const [modalError, setModalError] = useState<string | null>(null)

    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
      return () => clearInterval(timer)
    }, [])

    const source = rowSource(list)
    const groups = useMemo(
      () => deriveGroups(source, workspaces.items, workspaces.archivedSessionIds),
      [source, workspaces],
    )

    // An occupant that unloads mid-interaction leaves nobody to cancel.
    useEffect(() => {
      if (flowOpen && !flowAvailable) setFlowOpen(false)
    }, [flowOpen, flowAvailable])

    /** Adopt a picked directory; failures land in the folder-error dialog. */
    const adoptDirectory = (path: string): void => {
      setPickingFolder(true)
      deps.createWorkspace({ path }).then((workspace) => {
        setFlowOpen(false)
        deps.startSession(workspace.workspaceId)
      }).catch((reason: unknown) => {
        setFlowOpen(false)
        setModalError(reason instanceof Error ? reason.message : String(reason))
        setErrorOpen(true)
      }).finally(() => setPickingFolder(false))
    }

    const closeModal = (): void => {
      setErrorOpen(false)
      setModalError(null)
    }

    const flowOwner: DirectoryFlowOwner = {
      open: flowOpen,
      busy: pickingFolder,
      onPicked: (path) => { adoptDirectory(path) },
      onCancel: () => { setFlowOpen(false) },
      onError: (message) => {
        setFlowOpen(false)
        setModalError(message)
        setErrorOpen(true)
      },
    }

    const children: ReactNode[] = []
    if (props.wide) {
      children.push(createElement('div', { key: 'header', className: 'session-list-header' },
        createElement('span', { key: 'label', className: 'session-list-header-label' }, props.t('section.workspaces')),
        flowAvailable
          ? createElement(
            'button',
            {
              key: 'add',
              type: 'button',
              className: 'session-list-add',
              'aria-label': props.t('workspace.add'),
              title: props.t('workspace.add'),
              onClick: () => { setFlowOpen((open) => !open) },
            },
            createElement(IconProjectAddOutline16, { size: 16 }),
          )
          : null,
      ))
      const groupSections = groups.map((group) =>
        createElement(GroupSection, {
          key: group.key,
          group,
          collapsed: collapsedKeys.includes(group.key),
          overflowExpanded: overflowKeys.includes(group.key),
          onToggle: () => {
            setCollapsedKeys((keys) => keys.includes(group.key)
              ? keys.filter((candidate) => candidate !== group.key)
              : [...keys, group.key])
          },
          onCreate: (workspaceId) => {
            setCollapsedKeys((keys) => keys.filter((candidate) => candidate !== group.key))
            deps.startSession(workspaceId)
          },
          onToggleOverflow: () => {
            setOverflowKeys((keys) => keys.includes(group.key)
              ? keys.filter((candidate) => candidate !== group.key)
              : [...keys, group.key])
          },
          now,
          list,
          pending,
          t: props.t,
          open: deps.openSession,
          archive: deps.archiveSession,
        }))
      children.push(createElement(
        'div',
        { key: 'list', className: 'session-list-list', role: 'tree', 'aria-label': props.t('section.workspaces') },
        groupSections,
      ))
    } else {
      const rows = visibleRows(source, workspaces.archivedSessionIds)
      children.push(createElement(
        'div',
        { key: 'list', className: 'session-list-list', role: 'tree', 'aria-label': props.t('section.workspaces') },
        rows.map((row) =>
          createElement(SessionRow, {
            key: row.id,
            row,
            selected: list.current === row.id,
            hasPending: pending.has(row.id as SessionId),
            wide: false,
            now,
            t: props.t,
            open: deps.openSession,
            archive: deps.archiveSession,
          })),
      ))
    }

    return createElement(
      'div',
      { className: props.wide ? 'session-list-root' : 'session-list-root session-list-rail' },
      ...children,
      deps.renderDirectoryFlow(flowOwner),
      createElement(ErrorDialog, {
        key: 'error',
        open: errorOpen,
        title: props.t('folderError.title'),
        closeLabel: props.t('close'),
        message: modalError,
        retryDisabled: !flowAvailable,
        onClose: closeModal,
        onRetry: () => {
          closeModal()
          setFlowOpen(true)
        },
        cancelLabel: props.t('cancel'),
        retryLabel: props.t('folderError.retry'),
      }),
    )
  }
}

interface GroupProps {
  readonly group: SessionGroup
  readonly collapsed: boolean
  readonly overflowExpanded: boolean
  readonly onToggle: () => void
  readonly onCreate: (workspaceId: WorkspaceId) => void
  readonly onToggleOverflow: () => void
  readonly now: number
  readonly list: RowListSource
  readonly pending: SessionPendingInteractionSnapshot
  readonly t: Translate
  readonly open: (id: SessionId) => void
  readonly archive: (id: SessionId) => void
}

/** One workspace section: foldable header row, member sessions, Show more. */
export function GroupSection(props: GroupProps): ReactNode {
  const { group, collapsed, overflowExpanded, now, list, pending, t } = props
  const label = group.workspaceId === undefined ? t('group.ungrouped') : group.label
  const containsCurrent = list.current !== undefined
    && group.sessions.some((row) => row.id === list.current)
  const folded = collapsedSessionRows(group.sessions)
  const visible = collapsed ? [] : folded.rows
  const hiddenCount = collapsed ? 0 : folded.hiddenCount

  const children: ReactNode[] = [
    createElement(
      'div',
      {
        key: 'header',
        className: ['session-list-group-row', containsCurrent ? 'session-list-group-current' : null]
          .filter(Boolean).join(' '),
        role: 'treeitem',
        'aria-expanded': !collapsed,
        onClick: props.onToggle,
      },
      createElement(
        'span',
        { key: 'folder', className: 'session-list-folder' },
        createElement(collapsed ? IconFolderClose16 : IconFolderOpen16),
      ),
      createElement('span', { key: 'chevron', className: 'session-list-chevron' },
        createElement(IconTriangleRightFill14, { className: collapsed ? undefined : 'session-list-chevron-open' })),
      createElement('span', { key: 'title', className: 'session-list-group-title' }, label),
      group.workspaceId === undefined
        ? null
        : createElement(
          'span',
          { key: 'actions', className: 'session-list-group-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'session-list-group-action',
              'aria-label': t('actions.newSession.aria', { name: label }),
              onClick: (event: MouseEvent<HTMLElement>) => {
                event.stopPropagation()
                props.onCreate(group.workspaceId as WorkspaceId)
              },
            },
            createElement(IconPlusOutline16),
          ),
        ),
    ),
  ]
  if (!collapsed) {
    children.push(...visible.map((row) =>
      createElement(SessionRow, {
        key: row.id,
        row,
        selected: list.current === row.id,
        hasPending: pending.has(row.id as SessionId),
        wide: true,
        now,
        t,
        open: props.open,
        archive: props.archive,
      })))
    if (hiddenCount > 0) {
      children.push(createElement(
        'button',
        {
          key: 'overflow',
          type: 'button',
          className: 'session-list-overflow',
          'aria-expanded': overflowExpanded,
          onClick: props.onToggleOverflow,
        },
        overflowExpanded ? t('sessions.collapse') : t('sessions.expand', { n: hiddenCount }),
      ))
    }
    if (overflowExpanded) {
      const shown = new Set(visible.map((row) => row.id))
      children.push(...group.sessions.filter((row) => !shown.has(row.id)).map((row) =>
        createElement(SessionRow, {
          key: row.id,
          row,
          selected: list.current === row.id,
          hasPending: pending.has(row.id as SessionId),
          wide: true,
          now,
          t,
          open: props.open,
          archive: props.archive,
        })))
    }
  }
  return createElement('div', { key: group.key, className: 'session-list-group' }, ...children)
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

/** One session row: status dot, title, relative time, hover actions. */
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

interface ErrorDialogProps {
  readonly open: boolean
  readonly title: string
  readonly closeLabel: string
  readonly message: string | null
  readonly cancelLabel: string
  readonly retryLabel: string
  readonly retryDisabled: boolean
  readonly onClose: () => void
  readonly onRetry: () => void
}

/**
 * Folder-error dialog in the stock Modal's geometry (mask + r24 layer-2
 * card), rebuilt in place: the primitives' Modal drags the markdown/shiki
 * dependency cluster into the plugin bundle.
 */
function ErrorDialog(props: ErrorDialogProps): ReactNode {
  if (!props.open) return null
  return createElement(
    'div',
    { className: 'session-list-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
    createElement('div', { className: 'session-list-modal-mask', onClick: props.onClose }),
    createElement(
      'div',
      { className: 'session-list-modal-dialog' },
      createElement(
        'div',
        { className: 'session-list-modal-header' },
        createElement('h2', { className: 'session-list-modal-title' }, props.title),
        createElement(
          'button',
          {
            type: 'button',
            className: 'session-list-modal-close',
            'aria-label': props.closeLabel,
            onClick: props.onClose,
          },
          createElement(IconCloseFill14),
        ),
      ),
      createElement(
        'div',
        { className: 'session-list-modal-body' },
        createElement('div', { className: 'session-list-modal-error', role: 'alert' }, props.message),
      ),
      createElement(
        'div',
        { className: 'session-list-modal-footer' },
        createElement(
          'button',
          { type: 'button', className: 'session-list-modal-action session-list-modal-outline', onClick: props.onClose },
          props.cancelLabel,
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'session-list-modal-action session-list-modal-primary',
            disabled: props.retryDisabled,
            onClick: props.onRetry,
          },
          props.retryLabel,
        ),
      ),
    ),
  )
}
