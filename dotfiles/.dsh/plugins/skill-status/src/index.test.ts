import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
    SKILL_TOOL_NAME,
    isSuccessfulToolResult,
    skillNameFromCallArguments,
    skillStatusProjectionDefinition,
    type SkillStatusProjectionState,
    type SkillToolCallData,
    type ToolResultData,
} from './index'
import { SKILL_STATUS_PROJECTION_KEY } from './shared'

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

describe('shared contract', () => {
    it('targets the dsh skill tool', () => {
        assert.equal(SKILL_TOOL_NAME, 'skill')
    })

    it('names the projection key', () => {
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

/** Minimal immutable session metadata for `init` (brands erased at runtime). */
const header = { version: 3, id: 's1', createdAt: 0, isSeeded: false } as SessionHeader

/** One logged event as the fold consumes it (brands erased at runtime). */
function logged(event: { type: string; data: unknown }, seq: number) {
    return { type: event.type, seq, time: 0, data: event.data } as never
}

describe('skillStatusProjectionDefinition', () => {
    const definition = skillStatusProjectionDefinition
    const wire = definition.wire
    if (wire === undefined) throw new Error('unreachable: the definition declares wire')
    const offset = (value: number) => value as unknown as Parameters<typeof definition.init>[1]

    function fold(...events: { type: string; data: unknown }[]): SkillStatusProjectionState {
        let state: SkillStatusProjectionState = definition.init(header, offset(0))
        for (const [index, event] of events.entries()) {
            state = definition.apply(state, logged(event, index + 1))
        }
        return state
    }

    it('exposes the shared key, wire view of the names, and version 2', () => {
        assert.equal(definition.key, SKILL_STATUS_PROJECTION_KEY)
        assert.equal(definition.stateVersion, 2)
        assert.deepEqual(wire.view({ names: ['review', 'converge'], pending: [] }), [
            'review',
            'converge',
        ])
    })

    it('starts from empty names and no in-flight calls', () => {
        assert.deepEqual(definition.init(header, offset(0)), { names: [], pending: [] })
    })

    it('adds a name when the paired result succeeds, in completion order', () => {
        const state = fold(skillCall('c1', 'review'), toolResult('c1'), skillCall('c2', 'converge'), toolResult('c2'))
        assert.deepEqual(state, { names: ['review', 'converge'], pending: [] })
    })

    it('keeps an incomplete call pending so a later result still pairs', () => {
        const state = fold(skillCall('c1', 'tickets'))
        assert.deepEqual(state, { names: [], pending: [['c1', 'tickets']] })
        const done = definition.apply(state, logged(toolResult('c1'), 9))
        assert.deepEqual(done, { names: ['tickets'], pending: [] })
    })

    it('does not record a failed use and releases the call', () => {
        const state = fold(skillCall('c1', 'review'), toolResult('c1', { isError: true }))
        assert.deepEqual(state, { names: [], pending: [] })
    })

    it('keeps a repeated use silent', () => {
        const state = fold(
            skillCall('c1', 'review'),
            toolResult('c1'),
            skillCall('c2', 'review'),
            toolResult('c2'),
        )
        assert.deepEqual(state, { names: ['review'], pending: [] })
    })

    it('ignores results of other tools and calls of other tools', () => {
        const state = fold(
            { type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: '{}' } },
            { type: 'tool/result', data: { message: { content: [], source: { callId: 'c9' } } } },
        )
        assert.deepEqual(state, { names: [], pending: [] })
    })

    it('skips malformed skill arguments without state changes', () => {
        const state = definition.init(header, offset(0))
        const next = definition.apply(state, logged({ type: 'tool/call', data: { callId: 'c1', name: 'skill', arguments: 'broken' } }, 1))
        assert.equal(next, state)
    })

    it('keeps the same state reference for unrelated and duplicate events', () => {
        const state: SkillStatusProjectionState = { names: ['review'], pending: [] }
        assert.equal(definition.apply(state, { type: 'turn/start', seq: 1, time: 0, data: {} } as never), state)
        assert.equal(
            definition.apply(state, { type: 'tool/result', seq: 2, time: 0, data: { message: { content: [], source: { callId: 'unknown' } } } } as never),
            state,
        )
        const pending: SkillStatusProjectionState = { names: [], pending: [['c1', 'review']] }
        assert.equal(definition.apply(pending, logged(skillCall('c1', 'converge'), 3)), pending)
    })

    it('validates the wire view against its schema', () => {
        const viewSchema = wire.viewSchema
        assert.deepEqual(viewSchema.parse(['review', 'converge']), ['review', 'converge'])
        assert.throws(() => viewSchema.parse(['review', 42]))
        assert.throws(() => viewSchema.parse({ names: ['review'] }))
    })

    it('validates the persisted state against its schema', () => {
        const stateSchema = definition.stateSchema
        assert.deepEqual(stateSchema.parse({ names: ['review'], pending: [['c1', 'review']] }), {
            names: ['review'],
            pending: [['c1', 'review']],
        })
        assert.throws(() => stateSchema.parse({ names: 'review', pending: [] }))
        assert.throws(() => stateSchema.parse({ names: [], pending: [['c1', 42]] }))
    })
})
