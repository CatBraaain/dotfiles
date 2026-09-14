/**
 * Pure row derivation for the sidebar session list, kept react- and
 * primitives-free so tests stay dependency-free. Shapes mirror the host
 * list snapshot (`SessionListState` / `SessionSummary`) and the stock
 * WorkspaceBrowser's status precedence.
 */

/** The row facts the list renders (subset of the host `SessionSummary`). */
export interface RowSummary {
  readonly id: string
  /** Durable log-backed title; absent until the host projects one. */
  readonly title?: string | undefined
  /** Human-facing fallback label (durable title, basename, then session id). */
  readonly displayTitle: string
  readonly blank: boolean
  readonly running: boolean
  readonly completed?: boolean | undefined
  readonly updatedAt: number
  /** Coarse durable origin; subagent-origin rows stay hidden, as in stock. */
  readonly origin?: 'subagent'
}

/** Minimal face of the host list snapshot this module consumes. */
export interface RowListSource {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, RowSummary | undefined>>
  readonly current: string | undefined
}

/** StateDot states the list dot can take, in stock precedence order. */
export type RowDotState = 'warning' | 'ongoing' | 'done' | 'idle'

/** Group key for sessions outside every workspace (stock `UNGROUPED_KEY`). */
export const UNGROUPED_KEY = ''

/** Session rows visible per workspace before the Show-more overflow (stock). */
export const COLLAPSED_SESSION_LIMIT = 5

/** Minimal face of the host workspace view the grouping consumes. */
export interface WorkspaceGroupSource {
  readonly workspaceId: string
  readonly title: string
  /** Members in the workspace's durable manual order. */
  readonly sessionIds: readonly string[]
}

/** One workspace group section: header facts + visible member sessions. */
export interface SessionGroup {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  readonly key: string
  /** Backing workspace id; absent only for the ungrouped bucket. */
  readonly workspaceId: string | undefined
  /** Workspace display title; empty for the ungrouped bucket (the renderer
   * substitutes the localized label). */
  readonly label: string
  readonly sessions: readonly RowSummary[]
}

/** Stock visibility: ordinary sessions show; among blanks only the selected
 * provisional New Session row; archived and subagent-origin rows nowhere. */
function groupVisible(
  row: RowSummary,
  archived: ReadonlySet<string>,
  current: string | undefined,
): boolean {
  return row.origin !== 'subagent'
    && !archived.has(row.id)
    && (!row.blank || row.id === current)
}

/**
 * Group sessions by host workspace in stable host order, with members
 * resolved from each workspace's sessionIds in their stored order. Sessions
 * outside every workspace trail in the Ungrouped bucket (host list order);
 * the selected blank row rides there even when the host list omits it.
 */
export function deriveGroups(
  list: Pick<RowListSource, 'ids' | 'byId' | 'current'>,
  workspaces: readonly WorkspaceGroupSource[],
  archivedSessionIds: readonly string[],
): SessionGroup[] {
  const archived = new Set(archivedSessionIds)
  const groups: SessionGroup[] = []
  const accounted = new Set<string>()
  for (const workspace of workspaces) {
    const sessions: RowSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue
      accounted.add(id)
      if (!groupVisible(summary, archived, list.current)) continue
      sessions.push(summary)
    }
    groups.push({
      key: workspace.workspaceId,
      workspaceId: workspace.workspaceId,
      label: workspace.title,
      sessions,
    })
  }
  const stray: RowSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || accounted.has(id)) continue
    if (!groupVisible(summary, archived, list.current)) continue
    stray.push(summary)
  }
  if (list.current !== undefined) {
    const current = list.byId[list.current]
    if (current !== undefined && current.blank && !accounted.has(current.id)
      && !stray.some((candidate) => candidate.id === current.id)) {
      stray.unshift(current)
    }
  }
  if (stray.length > 0) {
    groups.push({ key: UNGROUPED_KEY, workspaceId: undefined, label: '', sessions: stray })
  }
  return groups
}

/**
 * Fold one workspace without charging its provisional New Session row
 * against the ordinary-row limit (stock `collapsedSessionRows`).
 */
export function collapsedSessionRows(sessions: readonly RowSummary[]): {
  rows: readonly RowSummary[]
  hiddenCount: number
} {
  let ordinaryCount = 0
  const rows = sessions.filter((session) => {
    if (session.blank) return true
    if (ordinaryCount >= COLLAPSED_SESSION_LIMIT) return false
    ordinaryCount += 1
    return true
  })
  return { rows, hiddenCount: sessions.length - rows.length }
}

/** Host rows in host order with subagent-origin, archived, and non-selected
 * blank rows removed (stock shows only the selected blank entry). */
export function visibleRows(
  list: Pick<RowListSource, 'ids' | 'byId' | 'current'>,
  archivedSessionIds: readonly string[],
): RowSummary[] {
  const archived = new Set(archivedSessionIds)
  const rows: RowSummary[] = []
  for (const id of list.ids) {
    const row = list.byId[id]
    if (row === undefined || row.origin === 'subagent' || archived.has(id)) continue
    if (row.blank && id !== list.current) continue
    rows.push(row)
  }
  return rows
}

/**
 * The selected blank New Session rides as one provisional extra row: when the
 * current blank session is absent from the host list rows, prepend it.
 */
export function ensureCurrentBlank(rows: RowSummary[], list: Pick<RowListSource, 'current' | 'byId'>): RowSummary[] {
  const current = list.current
  if (current === undefined) return rows
  const row = list.byId[current]
  if (row === undefined || !row.blank) return rows
  if (rows.some((candidate) => candidate.id === current)) return rows
  return [row, ...rows]
}

/** Stock status precedence: pending interaction, then live activity, then done/idle. */
export function dotState(row: RowSummary, hasPending: boolean): RowDotState {
  if (hasPending) return 'warning'
  if (row.running) return 'ongoing'
  if (row.completed) return 'done'
  return 'idle'
}

/** Row display title: blank rows show the localized New Session label. */
export function rowTitle(row: RowSummary, newSessionLabel: string): string {
  if (row.blank) return newSessionLabel
  return row.title || row.displayTitle
}

/** Shape of the primitives' relative-time bucket (kept structural for tests). */
export interface RelativeBucket {
  readonly unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  readonly n: number
}

/** Localized compact relative time through the declared dictionary. */
export function timeLabel(bucket: RelativeBucket, t: (key: string, params?: Record<string, unknown>) => string): string {
  return bucket.unit === 'now' ? t('time.now') : t(`time.${bucket.unit}`, { n: bucket.n })
}
