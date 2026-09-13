/**
 * quota-line — host half (main process, Node ESM).
 *
 * Queries the two provider quota endpoints the profile uses and serves the
 * normalized result over one exact web route the browser half polls:
 *
 * - zai: GLM Coding Plan quota from `{origin}/api/monitor/usage/quota/limit`,
 *   key resolved through the harness credentials service (`apiKeyEnv` ref of
 *   the configured zai/bigmodel provider, then well-known refs, then the
 *   process environment).
 * - codex: ChatGPT subscription usage from
 *   `chatgpt.com/backend-api/wham/usage`, authenticated with the OAuth grant
 *   stored in the harness credential records under `llm-pi-ai/openai-codex`
 *   (written by dsh's sign-in flow). The grant is rotated inside the
 *   credential store's exclusive lock when it nears expiry; grant logic is
 *   ported from dsh-provider-usage (github.com/lizhouai/dsh-provider-usage,
 *   `src/openai-codex.ts`, MIT).
 *
 * API keys and tokens never leave this process: the route answers quota
 * numbers only. A TTL cache plus in-flight dedup keeps the endpoints' rate
 * limits happy under UI polling.
 */

export const name = 'quota-line'
export const inject = ['webServer']

/** Quota rows cached this long; the UI polls at the same cadence. */
const CACHE_TTL_MS = 120_000
/** HTTPS request budget shared by the quota and token endpoints. */
const REQUEST_TIMEOUT_MS = 12_000
/** Credential refs tried (credentials service, then env) for the zai key. */
const ZAI_KEY_REFS = ['ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'ZAI_CODING_CN_API_KEY']
/** Credential record key holding the Codex OAuth grant (dsh sign-in flow). */
const CODEX_GRANT_KEY = 'llm-pi-ai/openai-codex'
/** Codex OAuth token endpoint and the public client id Codex CLI/pi-ai use. */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** Refresh slightly early so the token cannot expire mid-request. */
const CODEX_REFRESH_MARGIN_MS = 30_000
/**
 * Upstream verdicts that only a fresh dsh sign-in can clear: the refresh
 * token is single-use, so a consumed/revoked one cannot be recovered here.
 */
const CODEX_REAUTH_CODES = new Set(['refresh_token_reused', 'invalid_grant', 'invalid_token'])

/** Cache plus in-flight dedup shared by every route hit. */
const cache = { at: 0, value: null as unknown }
let inFlight: Promise<WirePayload> | null = null

/* ------------------------------------------------------------------ *
 * Structural context access (no runtime dependency on @deepseek-ai/*)
 * ------------------------------------------------------------------ */

interface WebRouteRequest {
	url?: string
}
interface WebRouteResponse {
	writeHead(status: number, headers: Record<string, string>): void
	end(body: string): void
}
interface WebServer {
	register(spec: {
		kind: string
		path: string
		handler: (req: WebRouteRequest, res: WebRouteResponse) => Promise<void>
	}): unknown
}
interface PluginContext {
	get(service: string): unknown
}

/* ------------------------------------------------------------------ *
 * zai (GLM Coding Plan)
 * ------------------------------------------------------------------ */

/**
 * Discover the coding-plan provider among configured llm providers and read
 * its credential ref (settings spell the field `apiKeyEnv`; older profiles
 * used `apiKeyEnvRef`) plus its baseUrl.
 */
function discoverZaiProvider(ctx: PluginContext): { ref?: string; baseUrl?: string } {
	try {
		const settings = ctx.get('settings') as { get?(key: string): unknown } | undefined
		const llm = settings?.get?.('llm-pi-ai') as { providers?: Record<string, { apiKeyEnv?: string; apiKeyEnvRef?: string; baseUrl?: string }> } | undefined
		const providers = llm?.providers ?? {}
		for (const [id, provider] of Object.entries(providers)) {
			if (!/zai|z\.ai|bigmodel|glm/i.test(id) && !/zai|z\.ai|bigmodel|glm/i.test(String(provider?.baseUrl ?? ''))) continue
			return { ref: provider?.apiKeyEnv ?? provider?.apiKeyEnvRef, baseUrl: provider?.baseUrl }
		}
	} catch { /* settings namespace absent — fall back to well-known refs */ }
	return {}
}

/** Resolve the raw zai key: the discovered ref first, then well-known names. */
async function resolveZaiKey(ctx: PluginContext, discoveredRef?: string): Promise<string | undefined> {
	const credentials = ctx.get('credentials') as { resolve?(ref: string): Promise<{ value?: string } | undefined> } | undefined
	const refs = [...(discoveredRef !== undefined ? [discoveredRef] : []), ...ZAI_KEY_REFS]
	for (const ref of refs) {
		try {
			const resolved = await credentials?.resolve?.(ref)
			if (resolved?.value) return resolved.value
		} catch { /* try the next candidate */ }
	}
	for (const ref of refs) {
		const fromEnv = process.env[ref]
		if (fromEnv !== undefined && fromEnv !== '') return fromEnv
	}
	return undefined
}

/**
 * Monitor endpoint for the configured provider: api.z.ai (international) vs
 * any bigmodel.cn host, defaulting to the CN open endpoint.
 */
function zaiQuotaUrl(baseUrl?: string): string {
	const base = String(baseUrl ?? '')
	const host = /api\.z\.ai/.test(base)
		? 'https://api.z.ai'
		: base.match(/https:\/\/[a-z0-9.-]*bigmodel\.cn/)?.[0] ?? 'https://open.bigmodel.cn'
	return `${host}/api/monitor/usage/quota/limit`
}

/** GET JSON with an abort budget; never follows redirects (the key must not
 * ride along to another origin). */
async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
	const status = response.status
	if (status !== 200) {
		// Drain so the socket can be reused, then fail with the status.
		await response.arrayBuffer().catch(() => undefined)
		throw new Error(`quota endpoint answered HTTP ${status}`)
	}
	return response.json() as Promise<unknown>
}

/**
 * The monitor endpoint answers HTTP 200 for auth errors and rate limiting
 * (body carries `success: false` / a non-200 `code`), so the body verdict is
 * checked before parsing. Mirrors dsh-glm-quota's classifyPayloadError.
 * Exported for the offline test.
 */
export function assertZaiPayload(payload: unknown): void {
	const root = payload as Record<string, unknown> | null
	if (root === null || typeof root !== 'object') {
		throw new Error(`zai quota endpoint returned an unexpected body (${typeof payload})`)
	}
	if (root.success !== true && root.code !== 200) {
		throw new Error(`zai quota endpoint rejected the query (code ${String(root.code ?? 'n/a')}): ${String(root.msg ?? 'unknown error')}`)
	}
}

interface ZaiResult {
	plan?: string
	rolling?: { percent: number; resetsAt?: number }
	weekly?: { percent: number; resetsAt?: number }
}

async function fetchZai(ctx: PluginContext): Promise<ZaiResult> {
	const { parseZaiQuota } = await import('./parse')
	const { ref, baseUrl } = discoverZaiProvider(ctx)
	const key = await resolveZaiKey(ctx, ref)
	if (key === undefined) {
		throw new Error('zai credential not found: no zai/bigmodel provider in settings, and no well-known ref resolved')
	}
	const payload = await fetchJson(zaiQuotaUrl(baseUrl), { accept: 'application/json', authorization: key })
	assertZaiPayload(payload)
	return parseZaiQuota(payload)
}

/* ------------------------------------------------------------------ *
 * codex (ChatGPT subscription)
 * ------------------------------------------------------------------ */

interface CodexGrant {
	type: 'oauth'
	access: string
	refresh: string
	expires: number
	accountId: string
}

interface CredentialRecord {
	kind: string
	payload?: unknown
}
interface CodexGrantStore {
	readRecord(key: string): Promise<CredentialRecord | undefined>
	modifyRecord(
		key: string,
		mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
	): Promise<CredentialRecord | undefined>
}

/**
 * Decode the ChatGPT account id embedded in a Codex OAuth access token
 * (JWT payload's `https://api.openai.com/auth` claim). Exported for the
 * offline test.
 */
export function codexAccountId(accessToken: string): string | null {
	try {
		const parts = accessToken.split('.')
		if (parts.length !== 3 || parts[1] === '') return null
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
		const auth = (payload as Record<string, unknown> | null)?.['https://api.openai.com/auth']
		const accountId = (auth as Record<string, unknown> | null)?.chatgpt_account_id
		return typeof accountId === 'string' && accountId !== '' ? accountId : null
	} catch {
		return null
	}
}

/** Validate the opaque grant payload written by dsh's sign-in flow.
 * Exported for the offline test. */
export function parseCodexGrant(payload: unknown): CodexGrant | null {
	const record = payload as Record<string, unknown> | null
	if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
	if (record.type !== 'oauth') return null
	if (typeof record.access !== 'string' || record.access === '') return null
	if (typeof record.refresh !== 'string' || record.refresh === '') return null
	if (typeof record.expires !== 'number' || !Number.isFinite(record.expires)) return null
	const stored = typeof record.accountId === 'string' && record.accountId !== '' ? record.accountId : null
	const accountId = stored ?? codexAccountId(record.access)
	if (accountId === null) return null
	return { type: 'oauth', access: record.access, refresh: record.refresh, expires: record.expires, accountId }
}

/**
 * Read a failed token response. OpenAI reports a consumed refresh token as a
 * nested object (`{ error: { code: 'refresh_token_reused' } }`) while the
 * OAuth spec uses a bare `error` string, so both shapes are unwrapped.
 */
function refreshFailure(body: Record<string, unknown>): { detail: string; reauth: boolean } {
	const description = typeof body.error_description === 'string' && body.error_description !== '' ? body.error_description : undefined
	const nested = body.error
	if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
		const nestedRecord = nested as Record<string, unknown>
		const code = typeof nestedRecord.code === 'string' && nestedRecord.code !== '' ? nestedRecord.code : typeof nestedRecord.type === 'string' && nestedRecord.type !== '' ? nestedRecord.type : undefined
		const message = typeof nestedRecord.message === 'string' && nestedRecord.message !== '' ? nestedRecord.message : undefined
		return {
			detail: message === undefined ? code ?? 'unknown error' : code === undefined ? message : `${message} (${code})`,
			reauth: code !== undefined && CODEX_REAUTH_CODES.has(code),
		}
	}
	if (typeof nested === 'string' && nested !== '') {
		return { detail: description ?? nested, reauth: CODEX_REAUTH_CODES.has(nested) }
	}
	return { detail: description ?? 'unknown error', reauth: false }
}

/** POST the refresh grant; upstream single-use tokens forbid retry-once. */
async function refreshCodexGrant(refreshToken: string): Promise<CodexGrant> {
	const response = await fetch(CODEX_TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CODEX_CLIENT_ID,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
	if (!response.ok || body === undefined) {
		const failure = body === undefined ? { detail: 'unreadable response body', reauth: false } : refreshFailure(body)
		if (failure.reauth) {
			throw new Error(`codex credential rejected (HTTP ${response.status}, ${failure.detail}) — sign in again via dsh to re-enable this row`)
		}
		throw new Error(`codex OAuth refresh failed (HTTP ${response.status}, ${failure.detail})`)
	}
	const access = body.access_token
	const refresh = body.refresh_token
	const expiresIn = body.expires_in
	if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '' || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
		throw new Error('codex OAuth refresh response is missing token fields')
	}
	const accountId = codexAccountId(access)
	if (accountId === null) throw new Error('codex OAuth access token has no ChatGPT account id')
	return { type: 'oauth', access, refresh, expires: Date.now() + expiresIn * 1000, accountId }
}

/**
 * Resolve the stored Codex grant, rotating it inside the credential store's
 * exclusive lock when it is near expiry. The network round trip happens
 * inside `mutate` on purpose: the refresh token is single-use upstream, so
 * deciding under the lock means a concurrent rotation is observed instead of
 * overwritten, and no token is ever spent twice (pattern ported from
 * dsh-provider-usage). A grant that is missing or unparseable returns
 * `undefined` — the row simply stays hidden until a dsh sign-in exists.
 */
async function resolveCodexGrant(ctx: PluginContext): Promise<CodexGrant | undefined> {
	const store = ctx.get('credentials') as CodexGrantStore | undefined
	if (store === undefined || typeof store.readRecord !== 'function' || typeof store.modifyRecord !== 'function') {
		return undefined
	}
	const existing = await store.readRecord(CODEX_GRANT_KEY)
	if (existing === undefined) return undefined
	const grant = parseCodexGrant(existing.payload)
	if (grant === null) return undefined
	if (grant.expires > Date.now() + CODEX_REFRESH_MARGIN_MS) return grant

	const committed = await store.modifyRecord(CODEX_GRANT_KEY, async current => {
		if (current === undefined) return undefined
		const fresh = parseCodexGrant(current.payload)
		if (fresh === null) return undefined
		if (fresh.expires > Date.now() + CODEX_REFRESH_MARGIN_MS) return undefined
		return { kind: 'grant', payload: await refreshCodexGrant(fresh.refresh) }
	})
	const settled = committed === undefined ? null : parseCodexGrant(committed.payload)
	return settled ?? grant
}

async function fetchCodex(ctx: PluginContext): Promise<ZaiResult> {
	const { parseCodexUsage } = await import('./parse')
	const grant = await resolveCodexGrant(ctx)
	if (grant === undefined) {
		throw new Error('no codex credential grant — sign in via dsh to enable this row')
	}
	const payload = await fetchJson(CODEX_USAGE_URL, {
		accept: 'application/json',
		authorization: `Bearer ${grant.access}`,
		'chatgpt-account-id': grant.accountId,
	})
	return parseCodexUsage(payload)
}

/* ------------------------------------------------------------------ *
 * Aggregation + route
 * ------------------------------------------------------------------ */

interface WireProvider extends ZaiResult {
	id: string
}
interface WirePayload {
	ok: true
	fetchedAt: number
	providers: WireProvider[]
	errors: Record<string, string>
}

async function fetchQuota(ctx: PluginContext, force: boolean): Promise<WirePayload> {
	if (!force && cache.value !== null && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.value as WirePayload
	}
	if (inFlight !== null) return inFlight
	inFlight = (async () => {
		try {
			const [zai, codex] = await Promise.all([
				fetchZai(ctx).then(
					value => ({ ok: true as const, value }),
					error => ({ ok: false as const, error }),
				),
				fetchCodex(ctx).then(
					value => ({ ok: true as const, value }),
					error => ({ ok: false as const, error }),
				),
			])
			const providers: WireProvider[] = []
			const errors: Record<string, string> = {}
			if (zai.ok) providers.push({ id: 'zai', ...zai.value })
			else errors.zai = String((zai.error as Error | undefined)?.message ?? zai.error)
			if (codex.ok) providers.push({ id: 'codex', ...codex.value })
			else errors.codex = String((codex.error as Error | undefined)?.message ?? codex.error)
			if (providers.length === 0) {
				throw new Error(`no quota provider available (${Object.entries(errors).map(([id, message]) => `${id}: ${message}`).join('; ')})`)
			}
			const value: WirePayload = { ok: true, fetchedAt: Date.now(), providers, errors }
			cache.at = Date.now()
			cache.value = value
			return value
		} finally {
			inFlight = null
		}
	})()
	return inFlight
}

/** Aggregation is exported for the offline aggregation test (test/index.test.ts). */
export { fetchQuota }

/** Serve the normalized quota JSON for the browser half to poll. */
export function apply(ctx: PluginContext): void {
	const webServer = ctx.get('webServer') as WebServer
	webServer.register({
		kind: 'exact',
		path: '/plugins/quota-line/quota.json',
		handler: async (req, res) => {
			// Query strings are not part of the exact-path match; read from the URL.
			const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
			try {
				const quota = await fetchQuota(ctx, force)
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
				res.end(JSON.stringify(quota))
			} catch (error) {
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
				res.end(JSON.stringify({ ok: false, error: String((error as Error | undefined)?.message ?? error) }))
			}
		},
	})
}
