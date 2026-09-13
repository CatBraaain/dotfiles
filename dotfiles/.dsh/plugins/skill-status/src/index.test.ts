import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
    SkillUsageTracker,
    SKILL_TOOL_NAME,
    isSuccessfulToolResult,
    skillNameFromCallArguments,
    skillStatusProjectionDefinition,
    type ReplayEvent,
    type SkillToolCallData,
    type SkillStatusProjectionState,
    type ToolResultData,
} from './index'
import {
    SKILL_STATUS_EVENT_TYPE,
    SKILL_STATUS_PROJECTION_KEY,
} from './shared'

function skillCall(callId: string, name: string): { type: 'tool/call'; data: SkillToolCallData } {
    return {
        type: 'tool/call',
        data: { callId, name: 'skill', arguments: JSON.stringify({ name }) },
    }
}

function toolResult(
    callId: string,
    options: { isError?: boolean; error?: { name: string; code: string } } = {},
): {
    type: 'tool/result'
    data: ToolResultData
} {
    return {
        type: 'tool/result',
        data: {
            message: {
                content: [{ isError: options.isError === true || options.error !== undefined }],
                source: { callId },
            },
            ...(options.error !== undefined ? { error: options.error } : {}),
        },
    }
}

function usedEvent(name: string): ReplayEvent {
    return { type: SKILL_STATUS_EVENT_TYPE, data: { name } }
}

describe('shared contract', () => {
    it('targets the dsh skill tool', () => {
        assert.equal(SKILL_TOOL_NAME, 'skill')
    })

    it('names the log-only event and the projection key', () => {
        assert.equal(SKILL_STATUS_EVENT_TYPE, 'skill-status/used')
        assert.equal(SKILL_STATUS_PROJECTION_KEY, 'skillStatus')
    })
})

describe('skillNameFromCallArguments', () => {
    it('extracts the requested skill name', () => {
        assert.equal(skillNameFromCallArguments('{"name":"coding-standard"}'), 'coding-standard')
    })

    it('rejects malformed payloads', () => {
        assert.equal(skillNameFromCallArguments('not json'), undefined)
        assert.equal(skillNameFromCallArguments('{"provider":"x"}'), undefined)
        assert.equal(skillNameFromCallArguments('{"name":""}'), undefined)
        assert.equal(skillNameFromCallArguments('{"name":42}'), undefined)
    })
})

describe('isSuccessfulToolResult', () => {
    it('treats a plain result as successful', () => {
        assert.equal(isSuccessfulToolResult(toolResult('c1').data), true)
    })

    it('treats an error identity or error block as failed', () => {
        assert.equal(
            isSuccessfulToolResult(
                toolResult('c1', { error: { name: 'Error', code: 'skill' } }).data,
            ),
            false,
        )
        assert.equal(isSuccessfulToolResult(toolResult('c1', { isError: true }).data), false)
    })
})

describe('SkillUsageTracker', () => {
    it('returns a name once for the first successful use only', () => {
        const tracker = SkillUsageTracker.empty()
        tracker.observeCall(skillCall('c1', 'review').data)
        assert.equal(tracker.observeResult(toolResult('c1').data), 'review')
        assert.equal(tracker.observeResult(toolResult('c1').data), undefined)
    })

    it('keeps a repeated use silent', () => {
        const tracker = SkillUsageTracker.fromEvents([usedEvent('review')])
        tracker.observeCall(skillCall('c2', 'review').data)
        assert.equal(tracker.observeResult(toolResult('c2').data), undefined)
    })

    it('does not record a failed use', () => {
        const tracker = SkillUsageTracker.empty()
        tracker.observeCall(skillCall('c1', 'review').data)
        assert.equal(
            tracker.observeResult(toolResult('c1', { error: { name: 'Error', code: 'x' } }).data),
            undefined,
        )
        // A later successful retry is still the first successful use.
        tracker.observeCall(skillCall('c2', 'review').data)
        assert.equal(tracker.observeResult(toolResult('c2').data), 'review')
    })

    it('ignores results of other tools', () => {
        const tracker = SkillUsageTracker.empty()
        assert.equal(tracker.observeResult(toolResult('unknown').data), undefined)
    })

    it('restores the used set and in-flight calls from a logged prefix', () => {
        const tracker = SkillUsageTracker.fromEvents([
            usedEvent('review'),
            skillCall('c1', 'converge'),
            toolResult('c1'),
            skillCall('c2', 'tickets'),
        ])
        assert.equal(tracker.usedNames().has('review'), true)
        assert.equal(tracker.usedNames().has('converge'), false)
        // c1 completed before the restore; only its durable record would count.
        // c2 was still in flight: its result after the restore is a first use.
        assert.equal(tracker.observeResult(toolResult('c2').data), 'tickets')
    })

    it('skips malformed skill arguments without state changes', () => {
        const tracker = SkillUsageTracker.empty()
        tracker.observeCall({ callId: 'c1', name: 'skill', arguments: 'broken' })
        assert.equal(tracker.observeResult(toolResult('c1').data), undefined)
    })
})

/** Minimal immutable session metadata for `init` (brands erased at runtime). */
const header = { version: 3, id: 's1', createdAt: 0, isSeeded: false } as SessionHeader

/** One logged `skill-status/used` event as the fold consumes it. */
function loggedUsedEvent(seq: number, name: string) {
    return { type: SKILL_STATUS_EVENT_TYPE, seq, time: 0, data: { name } } as never
}

describe('skillStatusProjectionDefinition', () => {
    const definition = skillStatusProjectionDefinition
    const wire = definition.wire
    if (wire === undefined) throw new Error('unreachable: the definition declares wire')
    const offset = (value: number) => value as unknown as Parameters<typeof definition.init>[1]

    it('exposes the shared key, wire view of the names, and version 1', () => {
        assert.equal(definition.key, SKILL_STATUS_PROJECTION_KEY)
        assert.equal(definition.stateVersion, 1)
        assert.deepEqual(wire.view({ names: ['review', 'converge'] }), [
            'review',
            'converge',
        ])
    })

    it('starts from an empty list regardless of session metadata', () => {
        const state = definition.init(header, offset(0))
        assert.deepEqual(state, { names: [] })
    })

    it('appends first-use names in log order', () => {
        let state: SkillStatusProjectionState = definition.init(header, offset(0))
        state = definition.apply(state, loggedUsedEvent(4, 'review'))
        state = definition.apply(state, loggedUsedEvent(9, 'converge'))
        assert.deepEqual(state, { names: ['review', 'converge'] })
    })

    it('keeps the same state reference for unrelated and malformed events', () => {
        const state: SkillStatusProjectionState = { names: ['review'] }
        assert.equal(definition.apply(state, { type: 'tool/result', seq: 1, time: 0, data: {} } as never), state)
        assert.equal(definition.apply(state, { type: SKILL_STATUS_EVENT_TYPE, seq: 2, time: 0, data: {} } as never), state)
        assert.equal(
            definition.apply(state, { type: SKILL_STATUS_EVENT_TYPE, seq: 3, time: 0, data: { name: 42 } } as never),
            state,
        )
    })

    it('keeps the same state reference for an already recorded name', () => {
        const state: SkillStatusProjectionState = { names: ['review'] }
        assert.equal(definition.apply(state, loggedUsedEvent(4, 'review')), state)
    })

    it('validates the wire view against its schema', () => {
        const viewSchema = wire.viewSchema
        assert.deepEqual(viewSchema.parse(['review', 'converge']), ['review', 'converge'])
        assert.throws(() => viewSchema.parse(['review', 42]))
        assert.throws(() => viewSchema.parse({ names: ['review'] }))
    })

    it('validates the persisted state against its schema', () => {
        const stateSchema = definition.stateSchema
        assert.deepEqual(stateSchema.parse({ names: ['review'] }), { names: ['review'] })
        assert.throws(() => stateSchema.parse({ names: 'review' }))
    })
})
