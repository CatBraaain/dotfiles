/**
 * Pure normalizers for the two quota endpoints this plugin queries.
 *
 * - zai: `GET {origin}/api/monitor/usage/quota/limit` (Z.AI / bigmodel GLM
 *   Coding Plan). Normalization logic ported from pi-usage
 *   (github.com/narumiruna/pi-extensions,
 *   `packages/pi-usage/src/providers/zai.ts`, MIT) and dsh-glm-quota
 *   (github.com/ardss/dsh-glm-quota, `plugin/index.js`
 *   parseQuota/percentOf, MIT).
 * - codex: `GET https://chatgpt.com/backend-api/wham/usage` (ChatGPT
 *   subscription). Normalization logic ported from pi-usage
 *   (github.com/narumiruna/pi-extensions,
 *   `packages/pi-usage/src/providers/codex.ts`, MIT).
 *
 * Both return the same display shape: a plan label (optional) plus at least
 * one of the rolling (≈5h) / weekly windows as used percents.
 */

/** One usage window as a used percent (0..100) with an optional reset epoch. */
export interface QuotaWindow {
	/** Percent of the window already used. */
	percent: number
	/** Epoch seconds the window resets at, when the endpoint reports one. */
	resetsAt?: number
}

/** Normalized quota for one provider: plan label plus rolling/weekly windows. */
export interface ProviderQuota {
	plan?: string
	rolling?: QuotaWindow
	weekly?: QuotaWindow
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		if (Number.isFinite(parsed)) return parsed
	}
	return undefined
}

function asString(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim() === '') return undefined
	return value
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value))
}

/** Epoch seconds from a millisecond timestamp; passes seconds through unchanged. */
function epochSeconds(value: unknown): number | undefined {
	const raw = asNumber(value)
	if (raw === undefined) return undefined
	// Heuristic split: real epoch-ms values sit far above any plausible epoch-seconds value.
	return raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw)
}

/**
 * Used percent from explicit counters when the plan reports them (preferred),
 * falling back to the legacy `percentage` field that historically means
 * percent used. Counter precedence follows dsh-glm-quota: the
 * `remaining + currentValue` total wins over the `usage` total.
 */
function percentOf(row: Record<string, unknown>): number | undefined {
	const remaining = asNumber(row.remaining)
	const current = asNumber(row.currentValue)
	const usage = asNumber(row.usage)
	if (remaining !== undefined && current !== undefined) {
		const total = remaining + current
		if (total > 0 && remaining >= 0 && remaining <= total) {
			return clampPercent((current / total) * 100)
		}
	}
	if (usage !== undefined && usage > 0 && current !== undefined && current >= 0 && current <= usage) {
		return clampPercent((current / usage) * 100)
	}
	const legacy = asNumber(row.percentage)
	if (legacy !== undefined) return clampPercent(legacy)
	return undefined
}

function windowOf(row: Record<string, unknown> | undefined): QuotaWindow | undefined {
	if (!row) return undefined
	const percent = percentOf(row)
	if (percent === undefined) return undefined
	const resetsAt = epochSeconds(row.nextResetTime)
	return resetsAt === undefined ? { percent } : { percent, resetsAt }
}

function byResetTime(a: Record<string, unknown>, b: Record<string, unknown>): number {
	const av = asNumber(a.nextResetTime) ?? Number.POSITIVE_INFINITY
	const bv = asNumber(b.nextResetTime) ?? Number.POSITIVE_INFINITY
	return av - bv
}

/**
 * Z.AI GLM Coding Plan quota. `data.limits` rows carry `TOKENS_LIMIT` /
 * `CREDIT_LIMIT` plan windows plus a `TIME_LIMIT` MCP lane this display
 * ignores. Plan windows are pinned by `unit` (3 = 5h, 6 = weekly) or
 * `number` (5 = 5h, 7 = weekly); plans that omit both markers are laid out
 * by reset time (soonest = 5h, next = weekly), matching dsh-glm-quota's
 * defensive ordering.
 */
export function parseZaiQuota(payload: unknown): ProviderQuota {
	const data = asObject(asObject(payload)?.data)
	if (!data) throw new Error('zai quota response had no data object')
	const limits = (Array.isArray(data.limits) ? data.limits : [])
		.map(asObject)
		.filter(row => row !== undefined)
	const plan = asString(data.level)

	const tokenRows = limits.filter(
		row => row.type === 'TOKENS_LIMIT' || row.type === 'CREDIT_LIMIT',
	)
	const matchesRolling = (row: Record<string, unknown>): boolean =>
		asNumber(row.unit) === 3 || asNumber(row.number) === 5
	const matchesWeekly = (row: Record<string, unknown>): boolean =>
		asNumber(row.unit) === 6 || asNumber(row.number) === 7

	let rolling = tokenRows.find(matchesRolling)
	let weekly = tokenRows.find(matchesWeekly)
	const leftovers = tokenRows
		.filter(row => row !== rolling && row !== weekly)
		.sort(byResetTime)
	for (const row of leftovers) {
		if (!rolling && percentOf(row) !== undefined) rolling = row
		else if (!weekly && percentOf(row) !== undefined) weekly = row
	}

	const result: ProviderQuota = {}
	if (plan) result.plan = plan
	const rollingWindow = windowOf(rolling)
	if (rollingWindow) result.rolling = rollingWindow
	const weeklyWindow = windowOf(weekly)
	if (weeklyWindow) result.weekly = weeklyWindow
	if (!result.rolling && !result.weekly) {
		throw new Error('zai quota response had no displayable usage windows')
	}
	return result
}

/**
 * OpenAI Codex (ChatGPT subscription) usage. `rate_limit.primary_window` is
 * the ≈5h rolling limit and `secondary_window` the weekly pool; the mapping
 * is positional, matching the endpoint's stable layout (same choice
 * dsh-quota-panel makes for its Codex adapter). `used_percent` rides through
 * as the window percent; `reset_at` is an epoch-seconds timestamp.
 */
export function parseCodexUsage(payload: unknown): ProviderQuota {
	const rateLimit = asObject(asObject(payload)?.rate_limit)
	if (!rateLimit) throw new Error('codex usage response had no rate_limit object')

	const result: ProviderQuota = {}
	const primary = asObject(rateLimit.primary_window)
	const primaryPercent = primary === undefined ? undefined : asNumber(primary.used_percent)
	if (primary !== undefined && primaryPercent !== undefined) {
		const resetsAt = epochSeconds(primary.reset_at)
		result.rolling = resetsAt === undefined ? { percent: clampPercent(primaryPercent) } : { percent: clampPercent(primaryPercent), resetsAt }
	}
	const secondary = asObject(rateLimit.secondary_window)
	const secondaryPercent = secondary === undefined ? undefined : asNumber(secondary.used_percent)
	if (secondary !== undefined && secondaryPercent !== undefined) {
		const resetsAt = epochSeconds(secondary.reset_at)
		result.weekly = resetsAt === undefined ? { percent: clampPercent(secondaryPercent) } : { percent: clampPercent(secondaryPercent), resetsAt }
	}
	if (!result.rolling && !result.weekly) {
		throw new Error('codex usage response had no displayable usage windows')
	}
	return result
}
