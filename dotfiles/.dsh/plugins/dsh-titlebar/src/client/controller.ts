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
 * While idle the plugin writes the plain title at most once per transition
 * and otherwise leaves `document.title` to the stock `DocumentTitle`
 * component; the mark is recognized back out of the live title on every
 * write, so stock rewrites are self-healing.
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

    constructor(sessions: TitlebarSessionsSource, pending: TitlebarPendingSource, host: TitlebarHost) {
        this.sessions = sessions
        this.pending = pending
        this.host = host
    }

    /** Subscribe to both state sources; safe to call once. */
    start(): void {
        this.sessions.subscribe(() => this.sync())
        this.pending.subscribe(() => this.sync())
        this.sync()
    }

    /** Unsubscribe, stop the timer, and restore the plain title. */
    dispose(): void {
        this.disposed = true
        this.stopTimer()
        const { plain } = splitMarkedTitle(this.host.getTitle())
        this.host.setTitle(plain)
    }

    /** Recompute the mark and write the title when it differs. */
    private sync(): void {
        if (this.disposed) return
        const mark = this.markForNow()
        const { plain } = splitMarkedTitle(this.host.getTitle())
        const next = buildTitle(mark, plain)
        if (next !== this.host.getTitle()) this.host.setTitle(next)
        this.updateTimer(mark)
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

    /** The spinner ticks only while the running mark is shown. */
    private updateTimer(mark: string | undefined): void {
        const running = mark !== undefined && mark !== WAITING_MARK
        if (running && this.timer === null) {
            this.timer = this.host.startTimer(() => this.sync(), SPINNER_INTERVAL_MS)
        } else if (!running && this.timer !== null) {
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
