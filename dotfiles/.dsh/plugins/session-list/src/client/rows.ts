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
