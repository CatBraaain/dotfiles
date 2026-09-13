// createStateFetcher: transport and wire contract between the browser half
// and the host's exact /api state route.
import { strict as assert } from 'node:assert/strict'
import { describe, it } from 'bun:test'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createStateFetcher } from './state.ts'

const sessionId = 'session-1' as SessionId

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })

const url = (): URL => new URL('/api/dsh-agents/state', 'https://dsh.invalid')

describe('createStateFetcher', () => {
  it('POSTs the session id to the state route and returns the parsed state', async () => {
    let captured: Request | undefined
    const fetcher = createStateFetcher(async (input, init) => {
      captured = new Request(url(), init)
      return json({ managed: true, agent: 'main', className: 'high', manual: false })
    })
    const state = await fetcher(sessionId)
    assert.equal(captured?.method, 'POST')
    assert.equal(captured?.url, url().href)
    assert.equal(captured?.headers.get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(await captured.text()), { sessionId: 'session-1' })
    assert.deepEqual(state, { managed: true, agent: 'main', className: 'high' })
  })

  it('drops the manual flag from the wire payload', async () => {
    const fetcher = createStateFetcher(async () => json({ managed: true, agent: 'main', className: 'high', manual: true }))
    assert.deepEqual(await fetcher(sessionId), { managed: true, agent: 'main', className: 'high', manual: true })
  })

  it('reads a non-2xx response as unmanaged', async () => {
    const fetcher = createStateFetcher(async () => new Response('not found', { status: 404 }))
    assert.deepEqual(await fetcher(sessionId), { managed: false })
  })

  it('reads an unmanaged payload as unmanaged', async () => {
    const fetcher = createStateFetcher(async () => json({ managed: false }))
    assert.deepEqual(await fetcher(sessionId), { managed: false })
  })

  it('reads a malformed body as unmanaged', async () => {
    const fetcher = createStateFetcher(async () => json({ managed: 'yes' }))
    assert.deepEqual(await fetcher(sessionId), { managed: false })
  })

  it('reads a transport failure as unmanaged', async () => {
    const fetcher = createStateFetcher(async () => {
      throw new TypeError('network down')
    })
    assert.deepEqual(await fetcher(sessionId), { managed: false })
  })
})
