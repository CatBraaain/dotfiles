import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { startStatePoller, type StatePollerDeps } from './controller'
import type { AgentDisplayState } from './format'

/** Timer handles captured by the stub clock. */
interface StubClock {
  readonly setIntervalCalls: number
  readonly clearIntervalCalls: number
  /** Fire the registered interval callback once. */
  tick: () => void
}

/** Injectable clock recording registrations; ticks only on demand. */
function createStubClock(): StubClock & Pick<StatePollerDeps, 'setInterval' | 'clearInterval'> {
  let callback: (() => void) | undefined
  let setIntervalCalls = 0
  let clearIntervalCalls = 0
  return {
    get setIntervalCalls() {
      return setIntervalCalls
    },
    get clearIntervalCalls() {
      return clearIntervalCalls
    },
    setInterval(callback_: () => void, _intervalMs: number): unknown {
      setIntervalCalls += 1
      callback = callback_
      return setIntervalCalls
    },
    clearInterval(_handle: unknown): void {
      clearIntervalCalls += 1
    },
    tick(): void {
      callback?.()
    },
  }
}

describe('startStatePoller', () => {
  it('fetches once immediately, then on every interval tick', async () => {
    const seen: AgentDisplayState[] = []
    const clock = createStubClock()
    let fetches = 0
    startStatePoller(2000, {
      fetchState: async () => {
        fetches += 1
        return { managed: true, agent: 'main', className: 'middle' }
      },
      onState: (state) => seen.push(state),
      ...clock,
    })
    await Promise.resolve()
    clock.tick()
    await Promise.resolve()

    assert.equal(fetches, 2)
    assert.equal(clock.setIntervalCalls, 1)
    assert.deepEqual(seen, [
      { managed: true, agent: 'main', className: 'middle' },
      { managed: true, agent: 'main', className: 'middle' },
    ])
  })

  it('keeps the last known state when a fetch fails', async () => {
    const seen: AgentDisplayState[] = []
    const clock = createStubClock()
    let fail = false
    const poller = startStatePoller(2000, {
      fetchState: async () => {
        if (fail) throw new Error('disconnected')
        return { managed: true, agent: 'main', className: 'middle' }
      },
      onState: (state) => seen.push(state),
      ...clock,
    })
    await Promise.resolve()
    assert.equal(seen.length, 1)

    fail = true
    clock.tick()
    await Promise.resolve()
    assert.equal(seen.length, 1)

    fail = false
    clock.tick()
    await Promise.resolve()
    assert.equal(seen.length, 2)
    poller()
  })

  it('stops fetching and clears the interval after the stop function runs', async () => {
    const clock = createStubClock()
    let fetches = 0
    const poller = startStatePoller(2000, {
      fetchState: async () => {
        fetches += 1
        return { managed: false }
      },
      onState: () => {},
      ...clock,
    })
    await Promise.resolve()
    assert.equal(fetches, 1)

    poller()
    clock.tick()
    await Promise.resolve()
    assert.equal(fetches, 1)
    assert.equal(clock.clearIntervalCalls, 1)
  })
})
