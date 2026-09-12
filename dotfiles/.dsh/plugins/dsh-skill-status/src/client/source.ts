/**
 * Per-session reactive source over the `skill-status` view snapshot.
 *
 * `binding.target(...)` activates the target on first subscribe and returns
 * the engine's own observable, so the dock component can feed it straight
 * into `useSyncExternalStore`. Sources are cached per binding (bindings are
 * stable per session) to keep `getSnapshot` identity-stable across renders.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EMPTY_SKILL_STATUS_SNAPSHOT, SKILL_STATUS_TARGET, type SkillStatusSnapshot } from './conversation'

/** Minimal observable the dock component consumes. */
export interface SkillStatusSource {
    getSnapshot(): SkillStatusSnapshot
    subscribe(listener: () => void): () => void
}

const cache = new WeakMap<object, SkillStatusSource>()

/** Return the stable `skill-status` snapshot source for one session. */
export function skillStatusSource(ctx: Context, sessionId: SessionId): SkillStatusSource {
    const binding = ctx.uiConversation.binding(sessionId)
    let source = cache.get(binding)
    if (source === undefined) {
        const target = binding.target(SKILL_STATUS_TARGET)
        source = {
            getSnapshot: () => target.getSnapshot() ?? EMPTY_SKILL_STATUS_SNAPSHOT,
            subscribe: (listener) => target.subscribe(listener),
        }
        cache.set(binding, source)
    }
    return source
}
