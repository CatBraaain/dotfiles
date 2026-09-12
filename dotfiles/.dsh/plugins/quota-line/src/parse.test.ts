import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { parseCodexUsage, parseZaiQuota } from './parse'

describe('parseZaiQuota', () => {
	it('pins the 5h window by unit=3 and the weekly pool by unit=6, preferring explicit counters over the legacy percentage', () => {
		const quota = parseZaiQuota({
			code: 200,
			success: true,
			data: {
				level: 'lite',
				limits: [
					{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 13, nextResetTime: 1771073738808 },
					{
						type: 'TOKENS_LIMIT', unit: 6, number: 7,
						usage: 500000, currentValue: 120000, percentage: 24, nextResetTime: 1744137600000,
					},
					{ type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 224, remaining: 3776 },
				],
			},
		})

		assert.equal(quota.plan, 'lite')
		assert.deepEqual(quota.rolling, { percent: 13, resetsAt: 1771073738 })
		assert.deepEqual(quota.weekly, { percent: 24, resetsAt: 1744137600 })
	})

	it('computes the used percent from remaining + currentValue when the counters are present', () => {
		const quota = parseZaiQuota({
			data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, remaining: 750, currentValue: 250 }] },
		})

		assert.equal(quota.rolling?.percent, 25)
	})

	it('falls back to currentValue/usage when remaining is absent', () => {
		const quota = parseZaiQuota({
			data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, usage: 400, currentValue: 100 }] },
		})

		assert.equal(quota.weekly?.percent, 25)
	})

	it('lays out unmarked plan rows by reset time: soonest becomes 5h, next becomes weekly', () => {
		const quota = parseZaiQuota({
			data: {
				limits: [
					{ type: 'TOKENS_LIMIT', percentage: 40, nextResetTime: 2000 },
					{ type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1000 },
				],
			},
		})

		assert.equal(quota.rolling?.percent, 10)
		assert.equal(quota.weekly?.percent, 40)
	})

	it('ignores the TIME_LIMIT MCP lane and CREDIT_LIMIT rides along with TOKENS_LIMIT', () => {
		const quota = parseZaiQuota({
			data: {
				limits: [
					{ type: 'TIME_LIMIT', unit: 5, percentage: 90 },
					{ type: 'CREDIT_LIMIT', unit: 3, percentage: 7 },
				],
			},
		})

		assert.equal(quota.rolling?.percent, 7)
		assert.equal(quota.weekly, undefined)
	})

	it('throws when no displayable window can be derived', () => {
		assert.throws(() => parseZaiQuota({ data: { limits: [{ type: 'TIME_LIMIT', percentage: 5 }] } }))
		assert.throws(() => parseZaiQuota({ data: { limits: [] } }))
		assert.throws(() => parseZaiQuota({}))
	})
})

describe('parseCodexUsage', () => {
	it('maps primary_window to rolling and secondary_window to weekly via used_percent', () => {
		const quota = parseCodexUsage({
			rate_limit: {
				primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_at: 1789240000 },
				secondary_window: { used_percent: 31, limit_window_seconds: 604800, reset_at: 1789800000 },
			},
		})

		assert.deepEqual(quota.rolling, { percent: 8, resetsAt: 1789240000 })
		assert.deepEqual(quota.weekly, { percent: 31, resetsAt: 1789800000 })
	})

	it('keeps a primary-only payload (no weekly pool reported)', () => {
		const quota = parseCodexUsage({
			rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18000 } },
		})

		assert.equal(quota.rolling?.percent, 55)
		assert.equal(quota.weekly, undefined)
	})

	it('treats a millisecond reset_at as epoch milliseconds', () => {
		const quota = parseCodexUsage({
			rate_limit: { primary_window: { used_percent: 0, reset_at: 1789240000000 } },
		})

		assert.equal(quota.rolling?.resetsAt, 1789240000)
	})

	it('throws when the payload carries no usable window', () => {
		assert.throws(() => parseCodexUsage({ rate_limit: {} }))
		assert.throws(() => parseCodexUsage({}))
	})
})
