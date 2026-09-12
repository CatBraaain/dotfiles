import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import {
    SkillStatusBuilder,
    namesFromNodes,
    skillStatusDefinition,
} from './conversation'
import { SKILL_STATUS_EVENT_TYPE } from './event'

/** Minimal event shape the Definition's match/start consume. */
function usedEvent(seq: number, name: string) {
    return {
        type: SKILL_STATUS_EVENT_TYPE,
        seq,
        time: 0,
        data: { name },
    } as Parameters<typeof skillStatusDefinition.match>[0]
}

describe('skillStatusDefinition.match', () => {
    it('accepts a used event as a start keyed by skill name', () => {
        assert.deepEqual(skillStatusDefinition.match(usedEvent(3, 'review')), {
            id: 'review',
            role: 'start',
        })
    })

    it('rejects other event types and malformed payloads', () => {
        assert.equal(
            skillStatusDefinition.match({ ...usedEvent(3, 'x'), type: 'tool/result' } as never),
            null,
        )
        assert.equal(
            skillStatusDefinition.match({ ...usedEvent(3, 'x'), data: {} } as never),
            null,
        )
    })
})

describe('namesFromNodes', () => {
    it('orders names by first-use seq and keeps first wins on duplicates', () => {
        const names = namesFromNodes([
            { key: 'b', data: { name: 'converge', seq: 9 } },
            { key: 'a', data: { name: 'review', seq: 4 } },
            { key: 'a2', data: { name: 'review', seq: 2 } },
        ] as never)
        assert.deepEqual(names, { names: ['review', 'converge'] })
    })
})

describe('SkillStatusBuilder', () => {
    it('rebuilds on replace and grows on apply', () => {
        const builder = new SkillStatusBuilder()
        assert.deepEqual(builder.empty, { names: [] })
        const timeline = { turnOrder: [], turns: new Map() } as never
        const first = builder.replace({
            nodes: [{ key: 'a', data: { name: 'review', seq: 1 } } as never],
            timeline,
        })
        assert.deepEqual(first, { names: ['review'] })
        const second = builder.apply({
            upserts: [{ key: 'b', data: { name: 'converge', seq: 5 } } as never],
            timeline,
        })
        assert.deepEqual(second, { names: ['review', 'converge'] })
    })
})
