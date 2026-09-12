/**
 * Unit tests for the titlebar state machine, over fake snapshot sources and a
 * fake host (title string, clock, timer). Assertions use `node:assert/strict`.
 */
import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, WAITING_MARK } from './format'
import { TitlebarController, type TitlebarHost } from './controller'

const PLAIN = 'My session — DeepSeek Harness'

function summary(id: string, running: boolean): SessionSummary {
    return { id: id as SessionId, displayTitle: id, running, blank: false, updatedAt: 0 }
}

function makeListState(current: string | undefined, running: boolean): SessionListState {
    const byId: Record<string, SessionSummary> = {}
    if (current !== undefined) byId[current] = summary(current, running)
    return {
        ids: current === undefined ? [] : [current as SessionId],
        byId,
        current: current as SessionId | undefined,
        phase: 'ready',
        subagentsByParent: {},
        jobsBySession: {},
        currentAddress: undefined,
    }
}

/** Mutable snapshot source: tests assign `.snapshot` then call `.emit()`. */
function makeSource<S>(initial: S) {
    const listeners = new Set<() => void>()
    const source = {
        snapshot: initial,
        getSnapshot: (): S => source.snapshot,
        subscribe: (fn: () => void): (() => void) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
        },
        emit: (): void => {
            for (const fn of listeners) fn()
        },
    }
    return source
}

interface FakeHost extends TitlebarHost {
    title: string
    nowMs: number
    timer: { handler: () => void; intervalMs: number } | null
}

function makeHost(): FakeHost {
    const host: FakeHost = {
        title: PLAIN,
        nowMs: 0,
        timer: null,
        getTitle: () => host.title,
        setTitle: (title) => {
            host.title = title
        },
        now: () => host.nowMs,
        startTimer: (handler, intervalMs) => {
            host.timer = { handler, intervalMs }
            return host.timer
        },
        stopTimer: () => {
            host.timer = null
        },
    }
    return host
}

function makeController(current: string | undefined, running: boolean) {
    const list = makeSource<SessionListState>(makeListState(current, running))
    const pending = makeSource(new Map<SessionId, { key: string; kind: string; sessionId: SessionId }>())
    const host = makeHost()
    const controller = new TitlebarController(list, pending, host)
    controller.start()
    return { host, list, pending, controller }
}

describe('TitlebarController', () => {
    it('leaves an unmarked title untouched while idle', () => {
        const { host } = makeController('s1', false)
        assert.equal(host.title, PLAIN)
    })

    it('shows no mark without a current session', () => {
        const { host } = makeController(undefined, true)
        assert.equal(host.title, PLAIN)
    })

    it('marks the running state with the current spinner frame and starts the timer', () => {
        const { host } = makeController('s1', true)
        assert.equal(host.title, `${SPINNER_FRAMES[0]} ${PLAIN}`)
        assert.equal(host.timer?.intervalMs, SPINNER_INTERVAL_MS)
    })

    it('advances the spinner frame on each tick', () => {
        const { host, controller } = makeController('s1', true)
        host.nowMs = SPINNER_INTERVAL_MS
        host.timer!.handler()
        assert.equal(host.title, `${SPINNER_FRAMES[1]} ${PLAIN}`)
        controller.dispose()
    })

    it('prefers the waiting mark while a question is pending, and stops the timer', () => {
        const { host, pending } = makeController('s1', true)
        pending.snapshot = new Map([['s1' as SessionId, { key: 'k', kind: 'question', sessionId: 's1' as SessionId }]])
        pending.emit()
        assert.equal(host.title, `${WAITING_MARK} ${PLAIN}`)
        assert.equal(host.timer, null)
    })

    it('resumes the spinner after the pending interaction is answered', () => {
        const { host, pending } = makeController('s1', true)
        pending.snapshot = new Map([['s1' as SessionId, { key: 'k', kind: 'question', sessionId: 's1' as SessionId }]])
        pending.emit()
        pending.snapshot = new Map()
        pending.emit()
        assert.equal(host.title, `${SPINNER_FRAMES[0]} ${PLAIN}`)
        assert.ok(host.timer !== null)
    })

    it('restores the plain title when the session stops running', () => {
        const { host, list } = makeController('s1', true)
        list.snapshot = makeListState('s1', false)
        list.emit()
        assert.equal(host.title, PLAIN)
        assert.equal(host.timer, null)
    })

    it('follows a session switch away from a running session', () => {
        const { host, list } = makeController('s1', true)
        const next = makeListState('s2', false)
        next.byId['s1' as SessionId] = summary('s1', true)
        list.snapshot = next
        list.emit()
        assert.equal(host.title, PLAIN)
    })

    it('dispose restores the plain title and stops reacting', () => {
        const { host, list, controller } = makeController('s1', true)
        controller.dispose()
        assert.equal(host.title, PLAIN)
        assert.equal(host.timer, null)
        list.snapshot = makeListState('s1', true)
        list.emit()
        assert.equal(host.title, PLAIN)
    })
})
