/**
 * Titlebar state machine: keep `document.title` in step with the current
 * session's agent state.
 *
 * State sources (both plain snapshot observables, no React):
 * - `ctx.sessions.list` — current session selection and its `running` flag
 * - `ctx.uiSession.pendingInteractions` — sessions waiting on user input
 *
 * Mark precedence mirrors pi: an input wait (⏸) wins over the running
 * spinner, because dsh keeps `running: true` while a question is pending.
 * While a mark is shown the timer keeps ticking — the spinner cycles, the
 * waiting mark stays static — so a stock rewrite of `document.title`
 * regains its mark within one tick. While idle the plugin writes the plain
 * title at most once per transition. Only a title the controller itself
 * wrote is treated as marked, so a base title that merely starts with
 * "mark + space" is never stripped.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import { buildTitle, SPINNER_INTERVAL_MS, splitMarkedTitle, spinnerFrame, WAITING_MARK } from './format'

/** Structural face of `ctx.sessions.list` the controller needs. */
export interface TitlebarSessionsSource {
    getSnapshot(): SessionListState
    subscribe(fn: () => void): () => void
}

/** Structural face of `ctx.uiSession.pendingInteractions` the controller needs. */
export interface TitlebarPendingSource {
    getSnapshot(): ReadonlyMap<SessionId, SessionPendingInteraction>
    subscribe(fn: () => void): () => void
}

/** Clock/timer/title seams, injectable for tests. */
export interface TitlebarHost {
    getTitle(): string
    setTitle(title: string): void
    now(): number
    startTimer(handler: () => void, intervalMs: number): unknown
    stopTimer(handle: unknown): void
}

export class TitlebarController {
    private readonly sessions: TitlebarSessionsSource
    private readonly pending: TitlebarPendingSource
    private readonly host: TitlebarHost
    private timer: unknown = null
    private disposed = false
    /** Unsubscribers captured by `start()`, released by `dispose()`. */
    private unsubscribe: (() => void) | null = null
    /** Full title string this controller last wrote; null before the first write. */
    private lastWritten: string | null = null

    constructor(sessions: TitlebarSessionsSource, pending: TitlebarPendingSource, host: TitlebarHost) {
        this.sessions = sessions
        this.pending = pending
        this.host = host
    }

    /** Subscribe to both state sources; safe to call once. */
    start(): void {
        const unsubscribers = [
            this.sessions.subscribe(() => this.sync()),
            this.pending.subscribe(() => this.sync()),
        ]
        this.unsubscribe = () => {
            for (const fn of unsubscribers) fn()
        }
        this.sync()
    }

    /** Unsubscribe, stop the timer, and restore the plain title. */
    dispose(): void {
        this.disposed = true
        this.unsubscribe?.()
        this.unsubscribe = null
        this.stopTimer()
        const live = this.host.getTitle()
        if (this.lastWritten !== null && live === this.lastWritten) {
            this.host.setTitle(this.plainOf(live))
        }
        // Otherwise stock rewrote the title after our last write, so `live` is
        // already the plain title and must be left alone.
    }

    /** Recompute the mark and write the title when it differs. */
    private sync(): void {
        if (this.disposed) return
        const live = this.host.getTitle()
        const mark = this.markForNow()
        const next = buildTitle(mark, this.plainOf(live))
        if (next !== live) {
            this.host.setTitle(next)
            this.lastWritten = next
        }
        this.updateTimer(mark)
    }

    /**
     * Extract the plain title from a live title. Only a title this controller
     * itself wrote is trusted to carry our leading mark; anything else —
     * including a base title that merely starts with "mark + space" — is kept
     * intact, so stock rewrites never get stripped.
     */
    private plainOf(live: string): string {
        if (this.lastWritten !== null && live === this.lastWritten) {
            return splitMarkedTitle(live).plain
        }
        return live
    }

    /** `⏸` while the current session waits for input, the spinner frame while it runs. */
    private markForNow(): string | undefined {
        const list = this.sessions.getSnapshot()
        const currentId = list.current
        if (currentId === undefined) return undefined
        if (this.pending.getSnapshot().has(currentId)) return WAITING_MARK
        if (list.byId[currentId]?.running === true) return spinnerFrame(this.host.now())
        return undefined
    }

    /**
     * Tick while any mark is shown: the spinner cycles its frames, and the
     * waiting mark re-asserts itself after a stock rewrite within one tick
     * (pi parity — pi keeps rendering while waiting for input).
     */
    private updateTimer(mark: string | undefined): void {
        const marked = mark !== undefined
        if (marked && this.timer === null) {
            this.timer = this.host.startTimer(() => this.sync(), SPINNER_INTERVAL_MS)
        } else if (!marked && this.timer !== null) {
            this.stopTimer()
        }
    }

    private stopTimer(): void {
        if (this.timer !== null) {
            this.host.stopTimer(this.timer)
            this.timer = null
        }
    }
}
