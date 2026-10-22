// RFC-374 AC-3/7: legacy catch-up preserves causal choices, resumes after failure and retains the identity high-water row.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first as firstRow } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { asc, eq, max } from 'drizzle-orm'
import { compareNodeRunMintOrder } from '@agent-workflow/shared'
import { backfillNodeRunSequences } from '@/modules/task-execution/application/nodeRunSeqBackfill'
import { planNodeRunSeqBackfill } from '@/modules/task-execution/domain/nodeRunSeqBackfill'
import { createNodeRunSeqBackfillStore } from '@/modules/task-execution/infrastructure/nodeRunSeqBackfillStore'
import { pickLatestRunInFrame, pickReusableShardRun } from '@/services/freshness'
import { describeEachProvider } from './helpers/eachProvider'
import { seedSequenceTask, mintSequenceRun } from './helpers/rfc374Fixtures'

describe('RFC-374 pure backfill planner', () => {
  test('empty history uses the set-based initial plan', () => {
    expect(planNodeRunSeqBackfill({ minSeq: null, maxId: null }, [])).toEqual({ kind: 'initial' })
  })
  test('mixed history splits older IDs from subsequent legacy writes in ID order', () => {
    const plan = planNodeRunSeqBackfill({ minSeq: 17, maxId: 'm' }, ['z', 'b', 'a', 'n'])
    expect(plan.kind).toBe('mixed')
    if (plan.kind !== 'mixed') throw new Error('expected mixed')
    expect(plan.older.map((row) => row.id)).toEqual(['a', 'b'])
    expect(plan.older[0]!.seq).toBeLessThan(plan.older[1]!.seq)
    expect(plan.older.at(-1)!.seq).toBeLessThan(17)
    expect(plan.newer).toEqual(['n', 'z'])
  })
  test('a batch that fills no row fails boot instead of listing the same tasks forever', async () => {
    let listed = 0
    const stuck = {
      listTaskIds: async () => {
        listed++
        return ['task-a']
      },
      backfillTask: async () => 0,
      assertAllocatorCurrent: async () => {},
      pruneAllocations: async () => 0,
    }
    await expect(backfillNodeRunSequences(stuck)).rejects.toThrow('node-run-seq-backfill-stalled')
    expect(listed).toBe(1)
  })
})

describeEachProvider('RFC-374 resumable sequence backfill', (harness) => {
  test('all-NULL tasks preserve the ID oracle, stay at or below zero, and are idempotent', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    const { nodeRuns } = tablesOf(db)
    await db
      .insert(nodeRuns)
      .values(['c', 'a', 'b'].map((id) => ({ id, taskId, nodeId: 'n', status: 'done' as const })))
    const store = createNodeRunSeqBackfillStore(db)
    const report = await backfillNodeRunSequences(store)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(rows.every((row) => row.seq !== null && row.seq <= 0)).toBe(true)
    expect([...rows].sort(compareNodeRunMintOrder).map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(report.runs).toBe(rows.length)
    expect(await backfillNodeRunSequences(store)).toEqual({
      tasks: 0,
      runs: 0,
      allocationsPruned: 0,
    })
    expect(await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toEqual(rows)
  })
  test('mixed old/new binary rows bracket existing rows without collisions and preserve the allocator', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await mintSequenceRun(db, taskId, { id: 'm' })
    const { nodeRuns, nodeRunSeqAllocations } = tablesOf(db)
    await db
      .insert(nodeRuns)
      .values(
        ['z', 'a', 'b', 'n'].map((id) => ({ id, taskId, nodeId: 'n', status: 'done' as const })),
      )
    const store = createNodeRunSeqBackfillStore(db)
    await backfillNodeRunSequences(store)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect([...rows].sort(compareNodeRunMintOrder).map((row) => row.id)).toEqual([
      'a',
      'b',
      'm',
      'n',
      'z',
    ])
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length)
    const allocations = await db.select().from(nodeRunSeqAllocations)
    expect(allocations).toHaveLength(1)
    expect(allocations[0]!.seq).toBe(Math.max(...rows.map((row) => row.seq!)))
    await mintSequenceRun(db, taskId, { id: 'clock-rewound' })
    const newest = await firstRow(
      db.select().from(nodeRuns).where(eq(nodeRuns.id, 'clock-rewound')),
    )
    expect(newest!.seq!).toBeGreaterThan(allocations[0]!.seq)
  })
  test('task failure preserves completed tasks and the next invocation resumes remaining work', async () => {
    const db = harness.db,
      first = await seedSequenceTask(db),
      second = await seedSequenceTask(db)
    const { nodeRuns } = tablesOf(db)
    for (const taskId of [first, second])
      await insertOne(db, nodeRuns, { id: `legacy-${taskId}`, taskId, nodeId: 'n', status: 'done' })
    const store = createNodeRunSeqBackfillStore(db)
    let attempts = 0
    await expect(
      backfillNodeRunSequences({
        ...store,
        async backfillTask(id) {
          if (++attempts === 2) throw new Error('injected-stop')
          return store.backfillTask(id)
        },
      }),
    ).rejects.toThrow('injected-stop')
    const midway = await db.select().from(nodeRuns)
    expect(midway.filter((row) => row.seq !== null)).toHaveLength(1)
    expect((await backfillNodeRunSequences(store)).runs).toBe(1)
    expect((await db.select().from(nodeRuns)).every((row) => row.seq !== null)).toBe(true)
  })
  test('allocator-behind rejects boot and does not prune the evidence', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await mintSequenceRun(db, taskId)
    const { nodeRunSeqAllocations, nodeRuns } = tablesOf(db)
    const highest = await firstRow(
      db.select({ seq: max(nodeRunSeqAllocations.seq) }).from(nodeRunSeqAllocations),
    )
    await insertOne(db, nodeRuns, {
      id: 'corrupt',
      taskId,
      nodeId: 'n',
      status: 'done',
      seq: highest!.seq! + 1,
    })
    const before = await db.select().from(nodeRunSeqAllocations)
    await expect(backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))).rejects.toThrow(
      'node-run-seq-allocator-behind',
    )
    expect(await db.select().from(nodeRunSeqAllocations)).toEqual(before)
  })
  test('bounded cleanup retains only the maximum allocation across tasks', async () => {
    const db = harness.db,
      a = await seedSequenceTask(db),
      b = await seedSequenceTask(db)
    for (const taskId of [a, b, a, b]) await mintSequenceRun(db, taskId)
    const { nodeRunSeqAllocations } = tablesOf(db)
    const before = await db
      .select()
      .from(nodeRunSeqAllocations)
      .orderBy(asc(nodeRunSeqAllocations.seq))
    expect(
      (await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))).allocationsPruned,
    ).toBe(before.length - 1)
    expect(await db.select().from(nodeRunSeqAllocations)).toEqual([before.at(-1)!])
  })
  for (const shape of [
    'wrapper-interrupted',
    'iso-pending-merge',
    'fanout-reuse',
    'review-waiting',
    'clarify-lineage',
  ] as const) {
    test(`in-flight ${shape} preserves its selection across catch-up`, async () => {
      const db = harness.db,
        taskId = await seedSequenceTask(db)
      const isShard = shape === 'fanout-reuse'
      const { nodeRuns } = tablesOf(db)
      await db.insert(nodeRuns).values([
        { id: 'wrapper', taskId, nodeId: 'wrapper', status: 'interrupted' },
        { id: 'fanout', taskId, nodeId: 'fanout', status: 'done' },
      ])
      await db.insert(nodeRuns).values(
        ['a', 'b'].map((id) => ({
          id,
          taskId,
          nodeId: 'n',
          iteration: 1,
          containerRunId: 'wrapper',
          parentNodeRunId: isShard ? 'fanout' : null,
          shardKey: isShard ? 'piece' : null,
          status:
            shape === 'review-waiting'
              ? ('awaiting_review' as const)
              : shape === 'wrapper-interrupted'
                ? ('interrupted' as const)
                : ('done' as const),
          mergeState: shape === 'iso-pending-merge' ? 'pending-merge' : null,
          rerunCause: shape === 'clarify-lineage' ? 'clarify-answer' : 'initial',
        })),
      )
      const before = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      const pick = (rows: typeof before) =>
        isShard
          ? pickReusableShardRun(rows, { shardKey: 'piece', valueHash: null })
          : pickLatestRunInFrame(rows, { containerRunId: 'wrapper', iteration: 1 })
      const selected = pick(before)!.id
      await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))
      const after = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(pick(after)!.id).toBe(selected)
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
      expect(after.map(({ seq: _seq, ...row }) => row).sort(byId)).toEqual(
        before.map(({ seq: _seq, ...row }) => row).sort(byId),
      )
    })
  }
})
