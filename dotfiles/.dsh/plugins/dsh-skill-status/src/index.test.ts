import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import {
    SkillUsageTracker,
    SKILL_STATUS_EVENT_TYPE,
    SKILL_TOOL_NAME,
    isSuccessfulToolResult,
    skillNameFromCallArguments,
    type ReplayEvent,
    type SkillToolCallData,
    type ToolResultData,
} from './index'
import { SKILL_STATUS_EVENT_TYPE as CLIENT_EVENT_TYPE } from './client/event'

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

describe('event contract', () => {
    it('keeps the host and client event type literals identical', () => {
        assert.equal(CLIENT_EVENT_TYPE, SKILL_STATUS_EVENT_TYPE)
    })

    it('targets the dsh skill tool', () => {
        assert.equal(SKILL_TOOL_NAME, 'skill')
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
