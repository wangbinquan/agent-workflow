// RFC-395 D4: NULL-sequence handling belongs to conversion, never normal boot.
import { describe, expect, test } from 'bun:test'
import {
  assignLegacySequences,
  planRunSequences,
} from '@/modules/task-execution/infrastructure/migration/run/sequence'
import { planNodeRunSeqBackfill } from '@/modules/task-execution/infrastructure/migration/run/legacySequencePlan'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import { sourceRow } from './helpers/rfc395V2/runFixtures'

describe('RFC-395 frozen sequence conversion', () => {
  test('empty and mixed plans retain the frozen ID ordering', () => {
    expect(planNodeRunSeqBackfill({ minSeq: null, maxId: null }, [])).toEqual({ kind: 'initial' })
    const plan = planNodeRunSeqBackfill({ minSeq: 17, maxId: 'm' }, ['z', 'b', 'a', 'n'])
    if (plan.kind !== 'mixed') throw new Error('expected mixed plan')
    expect(plan.older.map((row) => row.id)).toEqual(['a', 'b'])
    expect(plan.older.at(-1)!.seq).toBeLessThan(17)
    expect(plan.newer).toEqual(['n', 'z'])
  })
  test('all-NULL rows use nonpositive deterministic sequences without allocations or source mutation', () => {
    const source = ['c', 'a', 'b'].map((id) => ({ id, seq: null }))
    const before = JSON.stringify(source)
    const convert = () =>
      assignLegacySequences(source, {
        next() {
          throw new Error('unexpected allocation')
        },
      })
    const result = convert()
    expect([...result.seqById]).toEqual([
      ['a', -2],
      ['b', -1],
      ['c', 0],
    ])
    expect(result.allocated).toEqual([])
    expect([...result.derived].sort()).toEqual(['a', 'b', 'c'])
    expect(convert()).toEqual(result)
    expect(JSON.stringify(source)).toBe(before)
  })
  test('mixed rows bracket existing sequences and allocate later IDs above the high water', () => {
    let seq = 17
    const source = ['z', 'a', 'b', 'n'].map((id) => ({ id, seq: null as number | null }))
    source.push({ id: 'm', seq: 17 })
    const result = assignLegacySequences(source, { next: () => ++seq })
    expect([...result.seqById].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual([
      'a',
      'b',
      'm',
      'n',
      'z',
    ])
    expect(result.seqById.get('m')).toBe(17)
    expect(result.allocated).toEqual(['n', 'z'])
    expect(seq).toBe(19)
    expect(new Set(result.seqById.values()).size).toBe(source.length)
  })
  test('invalid conversion remains local to its task and preserves the global allocation plan', () => {
    const row = (id: string, task: string, seq: number | null) =>
      sourceRow('node_runs', { id, task_id: task, seq })
    const plans = planRunSequences(
      [row('a', 'bad', 1), row('b', 'bad', 1), row('c', 'good', null)],
      [],
    )
    expect(plans.get('bad')!.error).toContain('v2-run-sequence-duplicate')
    expect(plans.get('good')!.runs).toEqual([
      { id: 'c', seq: 0, derived: true, allocationOrdinal: null },
    ])
  })
  for (const status of ['interrupted', 'awaiting_review', 'done'] as const)
    test(`frozen ${status} history retains its selected run after deterministic conversion`, async () => {
      const rows = ['a', 'b'].map((id) => ({
        id,
        taskId: 'task',
        seq: null,
        nodeId: 'n',
        status,
        iteration: 1,
        containerRunId: 'wrapper',
        parentNodeRunId: null,
      }))
      const before = createRunSelectionOracleSnapshot(rows, { scope: { kind: 'rows' } })
      const plan = assignLegacySequences(rows, {
        next() {
          throw new Error('unexpected allocation')
        },
      })
      const after = createRunSelectionOracleSnapshot(
        rows.map((row) => ({ ...row, seq: plan.seqById.get(row.id)! })),
        { scope: { kind: 'rows' } },
      )
      const frame = { containerRunId: 'wrapper', iteration: 1 }
      expect((await after.currentInFrame('task', frame)).get('n')?.id).toBe(
        (await before.currentInFrame('task', frame)).get('n')?.id,
      )
    })
})
