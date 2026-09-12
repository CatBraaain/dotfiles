/**
 * Client-side Conversation assembly: one stateful Context per used skill.
 *
 * The `skill-status` view target publishes a `{ names }` snapshot assembled
 * from one view node per `skill-status/used` event (the host guarantees one
 * event per skill, first-use order by log seq; the builder keeps that order
 * and deduplicates defensively). The dock component subscribes to the
 * snapshot through `binding.target('skill-status')`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
    ConversationNodeDefinition,
    ConversationTimelineSnapshot,
    ConversationViewBuilder,
    ConversationViewDefinition,
    ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SKILL_STATUS_EVENT_TYPE } from './event'

/** View target owned by this plugin's Definition. */
export const SKILL_STATUS_TARGET = 'skill-status'

/** Snapshot published for the target: skill names in first-use order. */
export interface SkillStatusSnapshot {
    readonly names: readonly string[]
}

/** Snapshot before any event of ours has been seen. */
export const EMPTY_SKILL_STATUS_SNAPSHOT: SkillStatusSnapshot = { names: [] }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationViewSnapshotMap {
        [SKILL_STATUS_TARGET]: SkillStatusSnapshot
    }
}

/** Per-Context state: the used skill and the seq that first recorded it. */
interface SkillUseState {
    readonly name: string
    readonly seq: number
}

/** Node data handed to the view builder: {@link SkillUseState}. */
type SkillUseNode = ConversationViewNode & { readonly data: SkillUseState }

/** Extract a valid skill name from a `skill-status/used` payload. */
function usedSkillName(data: unknown): string | undefined {
    const name = (data as { readonly name?: unknown } | undefined)?.name
    return typeof name === 'string' && name.length > 0 ? name : undefined
}

/**
 * One Context per used skill. Every `skill-status/used` event is a start
 * (durable log-only events never update); a malformed payload is skipped
 * rather than guessed at.
 */
export const skillStatusDefinition: ConversationNodeDefinition<SkillUseState> = {
    kind: SKILL_STATUS_EVENT_TYPE,
    target: SKILL_STATUS_TARGET,
    match(event) {
        if (event.type !== SKILL_STATUS_EVENT_TYPE) return null
        const name = usedSkillName(event.data)
        return name === undefined ? null : { id: name, role: 'start' }
    },
    start(_context, match) {
        return { name: usedSkillName(match.event.data) ?? '', seq: match.event.seq }
    },
    update(context) {
        return context.state
    },
    buildViewNode(context) {
        const state = context.state
        return state === undefined ? null : {
            key: context.key,
            kind: skillStatusDefinition.kind,
            id: context.id,
            target: SKILL_STATUS_TARGET,
            data: state,
        }
    },
}

/** Assemble the names snapshot from view nodes, first use (lowest seq) first. */
export function namesFromNodes(
    nodes: readonly ConversationViewNode[],
): SkillStatusSnapshot {
    const seqs = new Map<string, number>()
    for (const node of nodes) {
        const data = (node as SkillUseNode).data
        if (typeof data?.name !== 'string' || typeof data?.seq !== 'number') continue
        const previous = seqs.get(data.name)
        if (previous === undefined || data.seq < previous) seqs.set(data.name, data.seq)
    }
    const names = [...seqs.entries()]
    names.sort((left, right) => left[1] - right[1])
    return { names: names.map(([name]) => name) }
}

/** Incremental builder behind the `skill-status` target. */
export class SkillStatusBuilder
    implements ConversationViewBuilder<ConversationViewNode, SkillStatusSnapshot>
{
    private readonly nodes = new Map<string, ConversationViewNode>()
    readonly empty: SkillStatusSnapshot = EMPTY_SKILL_STATUS_SNAPSHOT

    replace(input: {
        readonly nodes: readonly ConversationViewNode[]
        readonly timeline: ConversationTimelineSnapshot
    }): SkillStatusSnapshot {
        this.nodes.clear()
        for (const node of input.nodes) this.nodes.set(node.key, node)
        return namesFromNodes([...this.nodes.values()])
    }

    apply(input: {
        readonly upserts: readonly ConversationViewNode[]
        readonly timeline: ConversationTimelineSnapshot
    }): SkillStatusSnapshot {
        for (const node of input.upserts) this.nodes.set(node.key, node)
        return namesFromNodes([...this.nodes.values()])
    }
}

/** The view definition registering the snapshot builder for the target. */
export const skillStatusViewDefinition: ConversationViewDefinition = {
    target: SKILL_STATUS_TARGET,
    create: () => new SkillStatusBuilder(),
    // No `isActive`: this target never counts as visible Conversation activity.
}

/** Register the Definition (event → Context state) and the view target. */
export function registerSkillStatusConversation(ctx: Context): void {
    ctx.uiConversation.events.register(skillStatusDefinition)
    ctx.uiConversation.views.register(skillStatusViewDefinition)
}
