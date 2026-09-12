/** Build the visible quota line from the wire payload the host route serves. */

export interface DisplayQuotaWindow {
	percent: number
}

export interface DisplayProviderQuota {
	id: string
	plan?: string
	rolling?: DisplayQuotaWindow
	weekly?: DisplayQuotaWindow
}

/** `zai 13% 5h 24% wk` — id first, then the windows the plan carries. */
export function formatProviderLine(provider: DisplayProviderQuota): string {
	const segments = [provider.id]
	if (provider.rolling !== undefined) segments.push(`${Math.round(provider.rolling.percent)}% 5h`)
	if (provider.weekly !== undefined) segments.push(`${Math.round(provider.weekly.percent)}% wk`)
	return segments.join(' ')
}

/**
 * The line for the quota row the active provider feeds — the only row this
 * display ever shows. `quotaId === undefined` (route not mapped, or the
 * client session state not ready) renders nothing, as does a payload where
 * that provider failed or is absent.
 */
export function lineForProvider(payload: unknown, quotaId: string | undefined): string | null {
	if (quotaId === undefined) return null
	const root = payload as { ok?: unknown; providers?: unknown } | null
	if (root === null || typeof root !== 'object' || root.ok !== true || !Array.isArray(root.providers)) {
		return null
	}
	for (const raw of root.providers) {
		const provider = raw as DisplayProviderQuota | null
		if (provider === null || typeof provider !== 'object' || provider.id !== quotaId) continue
		const line = formatProviderLine(provider)
		if (line !== '') return line
	}
	return null
}
