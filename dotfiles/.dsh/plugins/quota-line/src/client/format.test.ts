import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { formatProviderLine, lineForProvider } from './format'

describe('formatProviderLine', () => {
	it('renders id, 5h rolling and weekly segments', () => {
		assert.equal(
			formatProviderLine({ id: 'zai', rolling: { percent: 13.4 }, weekly: { percent: 24 } }),
			'zai 13% 5h 24% wk',
		)
	})

	it('rounds fractional percents', () => {
		assert.equal(formatProviderLine({ id: 'codex', rolling: { percent: 7.6 } }), 'codex 8% 5h')
	})

	it('omits the weekly segment when the plan carries none', () => {
		assert.equal(formatProviderLine({ id: 'zai', rolling: { percent: 13 } }), 'zai 13% 5h')
	})

	it('omits the 5h segment for a weekly-only plan', () => {
		assert.equal(formatProviderLine({ id: 'codex', weekly: { percent: 31 } }), 'codex 31% wk')
	})
})

describe('lineForProvider', () => {
	const payload = {
		ok: true,
		providers: [
			{ id: 'zai', rolling: { percent: 13 }, weekly: { percent: 24 } },
			{ id: 'codex', rolling: { percent: 8 }, weekly: { percent: 31 } },
		],
	}

	it('renders only the row the active provider feeds', () => {
		assert.equal(lineForProvider(payload, 'zai'), 'zai 13% 5h 24% wk')
		assert.equal(lineForProvider(payload, 'codex'), 'codex 8% 5h 31% wk')
	})

	it('renders nothing while the selection is unmapped or unknown', () => {
		assert.equal(lineForProvider(payload, undefined), null)
		assert.equal(lineForProvider(payload, 'openrouter'), null)
	})

	it('renders nothing when the active provider has no quota row (failed or absent)', () => {
		const errorsPayload = { ok: true, providers: [{ id: 'zai', rolling: { percent: 13 } }] }

		assert.equal(lineForProvider(errorsPayload, 'codex'), null)
		assert.equal(lineForProvider({ ok: false, error: 'boom' }, 'zai'), null)
		assert.equal(lineForProvider(null, 'zai'), null)
	})
})