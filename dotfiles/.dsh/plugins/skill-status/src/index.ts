/**
 * dotfiles-dsh-skill-status — host half.
 *
 * Watches the `skill` tool of every live session and appends one log-only
 * `skill-status/used` event per first successful use; the client half renders
 * the session projection folded from those events above the composer. The
 * append is deferred to a microtask because the observation runs inside the
 * `session/event` publication window, where a re-entrant `session.append` is
 * rejected.
 *
 * The `skillStatus` session projection is the client's window-independent
 * read model: the framework folds `init` over the whole in-memory log and
 * drives every committed event through `apply`, so the published names cover
 * events outside the client's paged event window (see SPEC.md).
 *
 * `run_build.sh` bundles this entry: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external (see
 * dotfiles/.dsh/README.md). Shared literals live in `src/shared.ts`.
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
    SKILL_STATUS_EVENT_TYPE,
    SKILL_STATUS_PROJECTION_KEY,
    usedSkillName,
} from './shared'

export const name = 'dsh-skill-status'
export const inject = ['sessions', 'sessionProjections']

export { SKILL_STATUS_EVENT_TYPE, SKILL_STATUS_PROJECTION_KEY } from './shared'
export type { SkillStatusUsedData } from './shared'

/** Host fold state: the used skill names in first-use order. */
export interface SkillStatusProjectionState {
    readonly names: readonly string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        skillStatus: SkillStatusProjectionState
    }
}

/**
 * Fold `skill-status/used` events into the first-use ordered names. Unrelated
 * events and malformed payloads return the same state reference, and a name
 * already recorded is a no-op — the drive keys all downstream work on that.
 */
export const skillStatusProjectionDefinition = {
    key: SKILL_STATUS_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: z.object({ names: z.array(z.string()) }),
    init: (_header, _inheritedEventCount) => ({ names: [] }),
    apply: (state, event) => {
        if (event.type !== SKILL_STATUS_EVENT_TYPE) return state
        const used = usedSkillName(event.data)
        if (used === undefined || state.names.includes(used)) return state
        return { names: [...state.names, used] }
    },
    wire: {
        viewSchema: z.array(z.string()),
        view: (state) => state.names,
    },
} satisfies ProjectionDefinition<'skillStatus', SkillStatusProjectionState>

/** The dsh tool that loads a skill by name. */
export const SKILL_TOOL_NAME = 'skill'

/** Structural subset of a `tool/call` session event payload. */
export interface SkillToolCallData {
    readonly callId: string
    readonly name: string
    readonly arguments: string
}

/** Structural subset of a `tool/result` session event payload. */
export interface ToolResultData {
    readonly message: {
        readonly content: readonly { readonly isError?: boolean }[]
        readonly source: { readonly callId: string }
    }
    readonly error?: { readonly name: string; readonly code: string }
}

/** Structural subset of a session event, sufficient for replay. */
export interface ReplayEvent {
    readonly type: string
    readonly data: unknown
}

/** The name of the skill requested by one `skill` tool call, if parseable. */
export function skillNameFromCallArguments(argsRaw: string): string | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(argsRaw)
    } catch {
        return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const name = (parsed as { readonly name?: unknown }).name
    return typeof name === 'string' && name.length > 0 ? name : undefined
}

function isSkillToolCall(data: unknown): data is SkillToolCallData {
    if (typeof data !== 'object' || data === null) return false
    const call = data as Partial<SkillToolCallData>
    return (
        call.name === SKILL_TOOL_NAME &&
        typeof call.callId === 'string' &&
        typeof call.arguments === 'string'
    )
}

function isToolResult(data: unknown): data is ToolResultData {
    if (typeof data !== 'object' || data === null) return false
    const result = data as Partial<ToolResultData>
    const message = result.message as Partial<ToolResultData['message']> | undefined
    return typeof message?.source?.callId === 'string' && Array.isArray(message?.content)
}

/** A tool result is successful when it carries no failure identity or error block. */
export function isSuccessfulToolResult(data: ToolResultData): boolean {
    if (data.error !== undefined) return false
    return data.message.content[0]?.isError !== true
}

/**
 * Tracks first successful skill uses and in-flight `skill` tool calls.
 * `observeResult` returns the skill name exactly once — the first successful
 * completion that has no `skill-status/used` event yet — which the caller
 * appends as the durable record.
 */
export class SkillUsageTracker {
    private readonly used: Set<string>
    private readonly pending: Map<string, string>

    private constructor(used: Set<string>, pending: Map<string, string>) {
        this.used = used
        this.pending = pending
    }

    /** An empty tracker for a fresh session. */
    static empty(): SkillUsageTracker {
        return new SkillUsageTracker(new Set(), new Map())
    }

    /**
     * Restore the used set and in-flight calls from a logged event prefix:
     * only existing `skill-status/used` events count as used (uses from a run
     * where this plugin was not loaded stay unrecorded), while a `skill` call
     * without its result stays pending so its result still pairs after a
     * mid-turn plugin restart.
     */
    static fromEvents(events: readonly ReplayEvent[]): SkillUsageTracker {
        const used = new Set<string>()
        const pending = new Map<string, string>()
        for (const event of events) {
            if (event.type === SKILL_STATUS_EVENT_TYPE) {
                const name = (event.data as { readonly name?: unknown } | undefined)?.name
                if (typeof name === 'string' && name.length > 0) used.add(name)
            } else if (event.type === 'tool/call' && isSkillToolCall(event.data)) {
                const name = skillNameFromCallArguments(event.data.arguments)
                if (name !== undefined) pending.set(event.data.callId, name)
            } else if (event.type === 'tool/result' && isToolResult(event.data)) {
                pending.delete(event.data.message.source.callId)
            }
        }
        return new SkillUsageTracker(used, pending)
    }

    /** Names already recorded as used, in no defined order. */
    usedNames(): ReadonlySet<string> {
        return this.used
    }

    /** Record one `skill` tool call; a later result with the same callId completes it. */
    observeCall(data: SkillToolCallData): void {
        const name = skillNameFromCallArguments(data.arguments)
        if (name !== undefined) this.pending.set(data.callId, name)
    }

    /**
     * Record one tool result and return the skill name to persist, exactly
     * once per skill: only a successful completion of a pending `skill` call
     * whose name has no durable record yet yields a name.
     */
    observeResult(data: ToolResultData): string | undefined {
        const callId = data.message.source.callId
        const name = this.pending.get(callId)
        if (name === undefined) return undefined
        this.pending.delete(callId)
        if (!isSuccessfulToolResult(data)) return undefined
        if (this.used.has(name)) return undefined
        this.used.add(name)
        return name
    }
}

/**
 * Structural view of `Session.snapshotEvents`, bypassing the branded offset
 * parameters (the brands share one numeric domain; the runtime takes plain
 * numbers). Everything else uses the real `Session` types.
 */
interface SessionEventReader {
    snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
}

/** Return the tracker for `session`, seeded from the logged prefix before `event`. */
function trackerFor(
    trackers: Map<object, SkillUsageTracker>,
    session: Session,
    event: SessionEvent,
): SkillUsageTracker {
    let tracker = trackers.get(session)
    if (tracker === undefined) {
        const events = (session as unknown as SessionEventReader).snapshotEvents(
            undefined,
            event.seq,
        )
        tracker = SkillUsageTracker.fromEvents(events)
        trackers.set(session, tracker)
    }
    return tracker
}

export function apply(ctx: Context): void {
    const logger = ctx.logger(name)
    // Explicit type arguments: the registry's generic inference does not
    // recover `key` through its `Omit`-wrapped parameter type.
    ctx.sessionProjections.register<'skillStatus', SkillStatusProjectionState>(
        skillStatusProjectionDefinition,
    )
    const trackers = new Map<object, SkillUsageTracker>()

    ctx.on('session/disposed', (session) => {
        trackers.delete(session)
    })

    ctx.on('session/event', (session, event) => {
        if (event.type === 'tool/call' && event.data.name === SKILL_TOOL_NAME) {
            // Seeding on the call covers sessions adopted mid-turn: the logged
            // prefix already carries the call, so its later result still pairs.
            trackerFor(trackers, session, event).observeCall(event.data)
        } else if (event.type === 'tool/result') {
            const usedName = trackerFor(trackers, session, event).observeResult(event.data)
            if (usedName === undefined) return
            queueMicrotask(() => {
                try {
                    session.append(SKILL_STATUS_EVENT_TYPE, { name: usedName })
                } catch (error) {
                    logger.warn(
                        `failed to record used skill "${usedName}": ${String(error)}`,
                    )
                }
            })
        }
    })
}
