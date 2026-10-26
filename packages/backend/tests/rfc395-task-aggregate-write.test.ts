// PGX-E: root-locked mint writes use fresh statement snapshots without losing
// rollback/replay semantics or retrying inside an inherited aborted transaction.
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  withTaskExecutionAggregateWrite,
  withTaskExecutionSerializable,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { describeEachProvider } from './helpers/eachProvider'
import { workflowFixture } from './helpers/model'

describeEachProvider('RFC-395 replayable aggregate writes', (h) => {
  const rows = () =>
    h.db
      .select()
      .from(tablesOf(h.db).workflows)
      .where(eq(tablesOf(h.db).workflows.id, 'attempt'))

  test('top-level aggregate writes keep READ COMMITTED / BEGIN IMMEDIATE', async () => {
    const recording = h.recordStatements()
    try {
      await withTaskExecutionAggregateWrite(h.db, async (tx) => {
        if (h.applicationBinding.provider === 'postgresql') {
          expect(
            await rawRows(tx, sql`select current_setting('transaction_isolation') as level`),
          ).toEqual([{ level: 'read committed' }])
        }
        await workflowFixture(tx, { id: 'attempt', name: 'committed', definition: '{}' })
      })
    } finally {
      recording.stop()
    }
    expect(await rows()).toHaveLength(1)
    if (h.applicationBinding.provider === 'sqlite')
      expect(recording.statements.filter(({ sql }) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
  })

  test.each(['40001', '40P01'])(
    '%s rolls the entire failed attempt back before replay',
    async (errno) => {
      let attempts = 0
      await withTaskExecutionAggregateWrite(h.db, async (tx) => {
        attempts += 1
        // Reusing this PK in the second attempt also proves the first insert rolled back.
        await workflowFixture(tx, { id: 'attempt', name: `attempt-${attempts}`, definition: '{}' })
        if (attempts === 1) throw { errno }
      })
      expect(attempts).toBe(2)
      expect((await rows()).map((row) => row.name)).toEqual(['attempt-2'])
    },
  )

  test('a nested failure escapes once and leaves retry to the outer SERIALIZABLE owner', async () => {
    let outer = 0
    let inner = 0
    await withTaskExecutionSerializable(h.db, async (tx) => {
      outer += 1
      await withTaskExecutionAggregateWrite(tx, async (nested) => {
        inner += 1
        expect(nested).toBe(tx)
        if (h.applicationBinding.provider === 'postgresql')
          expect(
            await rawRows(nested, sql`select current_setting('transaction_isolation') as level`),
          ).toEqual([{ level: 'serializable' }])
        await workflowFixture(nested, { id: 'attempt', name: `outer-${outer}`, definition: '{}' })
        if (outer === 1 && h.applicationBinding.provider === 'postgresql') throw { errno: '40001' }
      })
    })
    const expected = h.applicationBinding.provider === 'postgresql' ? 2 : 1
    expect({ outer, inner }).toEqual({ outer: expected, inner: expected })
    expect((await rows()).map((row) => row.name)).toEqual([`outer-${expected}`])
  })

  test('ordinary outer transaction receives the original nested error without local replay', async () => {
    let attempts = 0
    const error = { errno: '40001' }
    const rejected = await h.session
      .transaction(async (tx) => {
        await withTaskExecutionAggregateWrite(tx, async (nested) => {
          attempts += 1
          expect(nested).toBe(tx)
          await workflowFixture(nested, { id: 'attempt', name: 'rolled back', definition: '{}' })
          throw error
        })
      })
      .catch((caught: unknown) => caught)
    expect(rejected).toBe(error)
    expect(attempts).toBe(1)
    expect(await rows()).toEqual([])
  })
})
