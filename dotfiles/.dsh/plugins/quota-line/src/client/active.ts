/**
 * Resolve the provider of the model the focused session currently has
 * selected, and subscribe to its changes.
 *
 * Contract ported from dsh-provider-usage (`src/client/index.ts`, MIT): the
 * focused session id rides the client `sessions` list snapshot, and the
 * per-session model directories (`modelDirectories`, the composer model
 * seat's shared state) expose the session's effective selection — pending →
 * last used → deployment default. Both are mounted by the web app and are
 * duck-typed here so this module stays independent of the host typings.
 */

/** Route provider ids this display knows how to map onto a quota row. */
const QUOTA_BY_ROUTE_PROVIDER: Readonly<Record<string, string>> = {
  zai: 'zai',
  'zai-coding-cn': 'zai',
  'openai-codex': 'codex',
}

export interface ActiveProviderServices {
  sessions?: {
    list?: {
      getSnapshot?(): { current?: unknown } | undefined
      subscribe?(fn: () => void): () => void
    }
  }
  modelDirectories?: {
    directoryFor?(sessionId: string): {
      store?: {
        getSnapshot?(): { current?: { provider?: unknown } | null } | undefined
        subscribe?(fn: () => void): () => void
      }
    }
  }
}

/** Map a dsh route provider id onto the quota row id it feeds, if any. */
export function quotaIdForRouteProvider(routeProvider: string | undefined): string | undefined {
  if (routeProvider === undefined || routeProvider === '') return undefined
  return QUOTA_BY_ROUTE_PROVIDER[routeProvider]
}

/**
 * The dsh route provider id the FOCUSED session's composer shows (and its
 * agent would use), or `undefined` while the client session state is not
 * ready. Exported for the offline test.
 */
export function resolveActiveRouteProvider(services: ActiveProviderServices): string | undefined {
  let current: unknown
  try {
    current = services.sessions?.list?.getSnapshot?.()?.current
  } catch {
    return undefined
  }
  if (typeof current !== 'string' || current === '') return undefined
  try {
    const provider = services.modelDirectories?.directoryFor?.(current)?.store?.getSnapshot?.()?.current?.provider
    return typeof provider === 'string' && provider !== '' ? provider : undefined
  } catch {
    // Session scope not resolvable yet — the next list event retries.
    return undefined
  }
}

/**
 * Re-run `onChange` the moment the focused session or its model selection
 * changes — without waiting for the next poll tick. The directory
 * subscription follows the CURRENT focused session and is re-pointed on
 * every session switch, so a late projection load still lands. Returns the
 * combined unsubscribe.
 */
export function subscribeActiveChange(services: ActiveProviderServices, onChange: () => void): () => void {
  const sessions = services.sessions
  if (typeof sessions?.list?.subscribe !== 'function') return () => {}
  let directoryUnsub: (() => void) | null = null
  const followDirectory = () => {
    directoryUnsub?.()
    directoryUnsub = null
    const current = sessions?.list?.getSnapshot?.()?.current
    if (typeof current === 'string' && current !== '') {
      try {
        const store = services.modelDirectories?.directoryFor?.(current)?.store
        if (typeof store?.subscribe === 'function') directoryUnsub = store.subscribe(onChange)
      } catch {
        /* directory not resolvable yet — the next session-list event retries */
      }
    }
  }
  const offList = sessions.list.subscribe(() => {
    followDirectory()
    onChange()
  })
  followDirectory()
  return () => {
    offList?.()
    directoryUnsub?.()
  }
}
