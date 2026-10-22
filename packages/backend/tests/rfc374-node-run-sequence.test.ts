// RFC-374 AC-1/2: allocation order survives inverted IDs, clock skew, rollback and concurrent provider transactions.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { newestNodeRun } from '@agent-workflow/shared'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { pickFreshestRun } from '@/services/freshness'
import { describeEachProvider } from './helpers/eachProvider'
import { seedSequenceTask, mintSequenceRun } from './helpers/rfc374Fixtures'
import { derivedSupersededIds, expectFencedToAbandoned } from './helpers/nodeRunSupersession'

describeEachProvider('RFC-374 node run allocation', (harness) => {
  test('more than 200 same-millisecond mints increase strictly in their minted order', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db),
      at = Date.now()
    const ids: string[] = []
    await databaseSessionFor(db).transaction(async (tx) => {
      const mint = createNodeRunMintParticipantInTx(tx)
      for (let n = 0; n < 205; n++)
        ids.push(
          await mint.mint({
            id: ulid(at),
            taskId,
            nodeId: 'n',
            iteration: 0,
            status: 'done',
            cause: 'initial',
          }),
        )
    })
    const { nodeRuns } = tablesOf(db)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (let n = 1; n < ids.length; n++)
      expect(byId.get(ids[n]!)!.seq!).toBeGreaterThan(byId.get(ids[n - 1]!)!.seq!)
    expect(pickFreshestRun(rows)?.id).toBe(ids.at(-1))
    expect(newestNodeRun(rows)?.id).toBe(ids.at(-1))
  })
  for (const cause of ['initial', 'wg-leader-round', 'review-iterate'] as const) {
    test(`${cause}: a preselected smaller ID supersedes the previously minted generation`, async () => {
      const db = harness.db,
        taskId = await seedSequenceTask(db)
      const old = await mintSequenceRun(db, taskId, { id: 'z-old' })
      const latest = await mintSequenceRun(db, taskId, { id: 'a-late', cause })
      const { nodeRuns } = tablesOf(db)
      await db
        .update(nodeRuns)
        .set({ mergeState: 'pending-merge' })
        .where(inArray(nodeRuns.id, [old, latest]))
      const reads = new DrizzleNodeExecutionPersistence(db)
      const rows = await reads.list({ taskId })
      expect(rows.map((row) => row.id)).toEqual([old, latest])
      expect(pickFreshestRun(rows)?.id).toBe(latest)
      expect(await derivedSupersededIds(db, taskId)).toEqual([old])
      expect(
        (await reads.list({ taskId, mergeState: 'pending-merge', excludeSuperseded: true })).map(
          (row) => row.id,
        ),
      ).toEqual([latest])
      await expectFencedToAbandoned(db, old)
    })
  }
  test('a host clock one minute behind still mints the newest row', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db),
      at = Date.now()
    const first = await mintSequenceRun(db, taskId, { id: ulid(at) })
    const second = await mintSequenceRun(db, taskId, { id: ulid(at - 60_000) })
    expect(second < first).toBe(true)
    const { nodeRuns } = tablesOf(db)
    expect(
      newestNodeRun(await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))?.id,
    ).toBe(second)
  })
  test('allocation rolls back with a failed node insert; retry succeeds without a run-row update', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    await mintSequenceRun(db, taskId, { id: 'duplicate' })
    const { nodeRunSeqAllocations, nodeRuns } = tablesOf(db)
    const before = await db.select().from(nodeRunSeqAllocations)
    await expect(mintSequenceRun(db, taskId, { id: 'duplicate' })).rejects.toBeDefined()
    expect(await db.select().from(nodeRunSeqAllocations)).toEqual(before)
    await mintSequenceRun(db, taskId, { id: 'retry' })
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length).toBe(2)
  })
  test('READ COMMITTED concurrent mints have distinct allocations with no unique violation', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    const ids = await Promise.all(
      Array.from({ length: 4 }, (_, n) => mintSequenceRun(db, taskId, { id: `concurrent-${n}` })),
    )
    const { nodeRuns } = tablesOf(db)
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.id, ids)))
    expect(rows).toHaveLength(ids.length)
    expect(rows.every((row) => row.seq !== null)).toBe(true)
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length)
  })
  test('SERIALIZABLE leader/member mints execute each body once', async () => {
    const db = harness.db,
      taskId = await seedSequenceTask(db)
    const bodies = [0, 0]
    const barrier = Promise.withResolvers<void>()
    let arrived = 0
    const mint = (n: number) =>
      databaseSessionFor(db).serializable(async (tx) => {
        bodies[n]!++
        await createNodeRunMintParticipantInTx(tx).mint({
          id: `host-${n}`,
          taskId,
          nodeId: n ? '__wg_member__' : '__wg_leader__',
          status: 'pending',
          cause: n ? 'wg-assignment' : 'wg-leader-round',
          overrides: { shardKey: n ? 'assignment' : null },
        })
        if (harness.applicationBinding.provider === 'postgresql' && bodies[n] === 1) {
          if (++arrived === 2) barrier.resolve()
          await barrier.promise
        }
      })
    await Promise.all([mint(0), mint(1)])
    expect(bodies).toEqual([1, 1])
  })
})
