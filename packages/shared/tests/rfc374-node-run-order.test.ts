// RFC-374: mint ordering stays total, transitive and compatible with legacy DTOs and lineage anchors.
import { describe, expect, test } from 'bun:test'
import {
  compareNodeRunMintOrder,
  isNewerNodeRun,
  newestNodeRun,
  nodeRunOrderAnchor,
} from '../src/nodeRunOrder'
import { NodeRunSchema } from '../src/schemas/task'
import { resolveHandlerRun, type RunLineageView } from '../src/task-questions'

const legacy = { id: 'z', seq: null }
const older = { id: 'y', seq: 8 }
const newer = { id: 'a', seq: 9 }

describe('RFC-374 shared mint order', () => {
  test('sequence, legacy and theoretical tie boundaries', () => {
    expect(compareNodeRunMintOrder(older, newer)).toBeLessThan(0)
    expect(compareNodeRunMintOrder(legacy, older)).toBeLessThan(0)
    expect(compareNodeRunMintOrder({ id: 'a', seq: null }, legacy)).toBeLessThan(0)
    expect(compareNodeRunMintOrder({ id: 'a', seq: 8 }, older)).toBeLessThan(0)
    expect(newestNodeRun([newer, legacy, older])).toBe(newer)
    expect(newestNodeRun([])).toBeUndefined()
    expect(isNewerNodeRun(newer, undefined)).toBe(true)
    expect(isNewerNodeRun(newer, newer)).toBe(false)
  })
  test('deterministic randomized mixed keys are antisymmetric, total and transitive', () => {
    let state = 374
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const rows = Array.from({ length: 128 }, (_, index) => ({
      id: String(random()),
      seq: index % 3 ? (random() % 31) - 15 : null,
    }))
    for (const a of rows)
      for (const b of rows) {
        const ab = compareNodeRunMintOrder(a, b)
        expect(Math.sign(ab) + Math.sign(compareNodeRunMintOrder(b, a))).toBe(0)
        if (ab === 0) expect(a).toEqual(b)
      }
    const sorted = [...rows].sort(compareNodeRunMintOrder)
    for (let a = 0; a < sorted.length; a++)
      for (let b = a; b < sorted.length; b++) {
        expect(compareNodeRunMintOrder(sorted[a]!, sorted[b]!)).toBeLessThanOrEqual(0)
      }
  })
  test('anchors resolve the row and use legacy keys only when absent', () => {
    expect(nodeRunOrderAnchor([newer, legacy], newer.id)).toBe(newer)
    expect(nodeRunOrderAnchor([newer], 'missing')).toEqual({ id: 'missing', seq: null })
  })
  test('DTO requires integer seq while historical ordering helpers retain legacy anchors', () => {
    const schema = NodeRunSchema.pick({ id: true, seq: true })
    expect(schema.safeParse({ id: 'legacy' }).success).toBe(false)
    expect(schema.safeParse({ id: 'legacy', seq: null }).success).toBe(false)
    expect(schema.parse(newer)).toEqual(newer)
    for (const seq of [1.5, '1', Infinity])
      expect(schema.safeParse({ id: 'bad', seq }).success).toBe(false)
  })
  test('handler lineage is bounded by mint order even with inverted IDs', () => {
    const run = (
      id: string,
      seq: number,
      rerunCause: string | null,
      status: RunLineageView['status'],
    ): RunLineageView => ({
      id,
      seq,
      rerunCause,
      status,
      nodeId: 'n',
      iteration: 0,
      loopIter: 0,
      startedAt: seq,
      hasOutput: status === 'done',
      parentNodeRunId: null,
      shardKey: null,
    })
    const trigger = run('z', 1, 'clarify-answer', 'failed')
    const retry = run('y', 2, 'process-retry', 'done')
    const next = run('a', 3, 'clarify-answer', 'pending')
    expect(
      resolveHandlerRun({
        effectiveTargetNodeId: 'n',
        iteration: 0,
        loopIter: 0,
        triggerRunId: trigger.id,
        runs: [next, trigger, retry],
      }),
    ).toEqual({ status: 'done', startedAt: retry.startedAt, hasOutput: true })
    expect(
      resolveHandlerRun({
        effectiveTargetNodeId: null,
        iteration: 0,
        loopIter: 0,
        triggerRunId: trigger.id,
        runs: [trigger],
      }),
    ).toBeNull()
  })
})
