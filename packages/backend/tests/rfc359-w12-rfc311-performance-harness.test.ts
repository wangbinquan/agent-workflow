// RFC-359 AC11: the old native RFC-311 seed and the bounded async sink share
// one corpus. These small real-database cases are data/shape evidence; HTTP
// latency and the full-size benchmark run separately in the hosted workflow.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { count, eq, getTableColumns } from 'drizzle-orm'
import {
  cachedRepos,
  nodeRunEvents,
  nodeRuns,
  tasks,
  webhookDeliveries,
  workflows,
} from '@/db/schema'
import {
  PERF_CORPUS_CHUNKS,
  PERF_CORPUS_FULL_DIMENSIONS,
  PERF_CORPUS_SMALL_DIMENSIONS,
  perfCorpusCounts,
  perfCorpusRanges,
  perfEventRow,
  perfNodeRunRow,
  perfRepoRow,
  perfTaskRow,
  type PerfCorpusDimensions,
} from '../../../scripts/perf-corpus'
import {
  readPerformanceCorpusReceipt,
  seedPerformanceCorpus,
  seedPerformanceCorpusEntry,
  type PerfCorpusSeedProgress,
} from '../../../scripts/perf-seed'
import { describeEachProvider } from './helpers/eachProvider'

const TINY: PerfCorpusDimensions = {
  tasks: 23,
  runsPerTask: 5,
  events: 361,
  deliveries: 11,
  repos: 7,
}

// Captured from every generated row of the actual old native SQLite CLI,
// source SHA256 0c1738431ec3f01eb1ff15e681c1150dbdcc8564b8687109b7e24d1dd6f6084a.
// Each ordered row hashes its explicit input values, plus the observed task
// lineage and node-run defaults; event IDs come from the real database.
const OLD_NATIVE_DIGESTS = {
  cachedRepos: 'c61d65ff65e61ae7b1077419894566db63e71726252157f01d964a82cc01cfee',
  tasks: '68655826366e594c7c9fc24227bb6900027df9c15e1722f26c807fe517688b4c',
  nodeRuns: 'ae35d41e00db847bbcfff8064703cf367663c57fb7b4a69741303ce5c717d134',
  nodeRunEvents: 'f236486a53d88b0afd9880ae059f02c7b02233496ac182f2850c30eeb626a4f4',
  webhookDeliveries: '5995dd20a92681c6b7a6fc8e2b7171688f987d5dda41771706f26b5f3f0fb034',
}

function allColumnDigest(rows: readonly object[]): string {
  const hash = createHash('sha256')
  for (const row of rows) {
    const physical = Object.fromEntries(
      Object.entries(row)
        .map(
          ([key, value]) =>
            [
              key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
              typeof value === 'boolean' ? Number(value) : value,
            ] as const,
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
    hash.update(JSON.stringify(physical) + '\n')
  }
  return hash.digest('hex')
}

describe('RFC-311 shared corpus arithmetic', () => {
  test('full/small dimensions and old outer transaction boundaries remain exact', () => {
    expect(perfCorpusCounts(PERF_CORPUS_FULL_DIMENSIONS)).toEqual({
      cachedRepos: 500,
      tasks: 100_000,
      nodeRuns: 3_000_000,
      nodeRunEvents: 10_000_000,
      webhookDeliveries: 100_000,
    })
    expect(perfCorpusCounts(PERF_CORPUS_SMALL_DIMENSIONS)).toEqual({
      cachedRepos: 5,
      tasks: 1_000,
      nodeRuns: 30_000,
      nodeRunEvents: 100_000,
      webhookDeliveries: 1_000,
    })
    expect(PERF_CORPUS_CHUNKS).toEqual({
      tasks: 20_000,
      nodeRuns: 50_000,
      nodeRunEvents: 100_000,
      webhookDeliveries: 50_000,
    })
    for (const chunk of [20_000, 50_000, 100_000]) {
      expect([...perfCorpusRanges(chunk - 1, chunk)]).toEqual([{ base: 0, hi: chunk - 1 }])
      expect([...perfCorpusRanges(chunk, chunk)]).toEqual([{ base: 0, hi: chunk }])
      expect([...perfCorpusRanges(chunk + 1, chunk)]).toEqual([
        { base: 0, hi: chunk },
        { base: chunk, hi: chunk + 1 },
      ])
    }
    expect([...perfCorpusRanges(0, 20_000)]).toEqual([])
    for (const invalid of [0, -1, 0.5, Infinity, NaN]) {
      expect(() => [...perfCorpusRanges(1, invalid)]).toThrow(RangeError)
    }
  })

  test('task child timing, trailing root and interleaved run index preserve old expressions', () => {
    expect(perfTaskRow(8, TINY).branchStartedAt).toBe(1_767_226_602_561)
    expect(perfTaskRow(9, TINY)).toMatchObject({
      startedAt: 1_767_226_602_561,
      finishedAt: 1_767_226_662_561,
      parentTaskId: 'perftask0000008',
      rootTaskId: 'perftask0000008',
      invocationDepth: 1,
    })
    expect(perfTaskRow(8, { ...TINY, tasks: 9 }).branchStartedAt).toBe(1_767_226_437_832)
    expect(perfNodeRunRow(23, TINY)).toMatchObject({
      taskId: 'perftask0000000',
      nodeId: 'node-1',
      iteration: 0,
      retryIndex: 0,
      startedAt: 1_767_225_601_000,
    })
    expect([0, 1, 2, 3].map((i) => perfRepoRow(i).hasSubmodules)).toEqual([1, 0, null, null])
    expect([0, 1, 2, 3, 4, 6].map((i) => perfEventRow(i, TINY).nodeRunId)).toEqual([
      'perfrun00000000',
      'perfrun00000001',
      'perfrun00000002',
      'perfrun00000001',
      'perfrun00000004',
      'perfrun00000000',
    ])
  })
})

describeEachProvider('RFC-311 performance corpus real database', (harness) => {
  test('all five tables match the actual old native rows, order, nulls and raw lineage bytes', async () => {
    const progress: PerfCorpusSeedProgress[] = []
    const receipt = await seedPerformanceCorpus({
      db: harness.db,
      session: harness.session,
      dimensions: TINY,
      onProgress: (item) => {
        progress.push(item)
      },
    })
    expect(receipt.version).toBe(1)
    expect(receipt.actualCounts).toEqual({
      cachedRepos: 7,
      tasks: 23,
      nodeRuns: 115,
      nodeRunEvents: 361,
      webhookDeliveries: 11,
    })
    expect(receipt.expectedDigests).toEqual(OLD_NATIVE_DIGESTS)
    expect(receipt.actualDigests).toEqual(OLD_NATIVE_DIGESTS)
    expect(receipt.matchesExpected).toBe(true)
    // Independent old physical-row goldens also cover every omitted schema default.
    expect({
      cachedRepos: allColumnDigest(
        await harness.db.select().from(cachedRepos).orderBy(cachedRepos.id).all(),
      ),
      tasks: allColumnDigest(await harness.db.select().from(tasks).orderBy(tasks.id).all()),
      nodeRuns: allColumnDigest(
        await harness.db.select().from(nodeRuns).orderBy(nodeRuns.id).all(),
      ),
      nodeRunEvents: allColumnDigest(
        await harness.db.select().from(nodeRunEvents).orderBy(nodeRunEvents.id).all(),
      ),
      webhookDeliveries: allColumnDigest(
        await harness.db.select().from(webhookDeliveries).orderBy(webhookDeliveries.id).all(),
      ),
    }).toEqual({
      cachedRepos: '049c5274754fbad8f36a4e0eab251627306cd73eff6da6d64f329af59c02c75f',
      tasks: '0c3c286f9176efb7593fa09a1313c89f51e47f4548ef2f5f8170b547b21cf8e9',
      nodeRuns: 'a4064482e422190467e982844449c2ad8b664974c06fb87a5ed1ecc10bc31383',
      nodeRunEvents: '7cee993669b0192816195d5c2646b36bb098bb18bdb390c95146f8b3cd233bc0',
      webhookDeliveries: 'c706e9dc61a968060cb9fcc103e3bfe04d1998d1f4d4069c0b156c5953d10d59',
    })
    expect(progress.map((item) => [item.table, item.inserted, item.total])).toEqual([
      ['cachedRepos', 7, 7],
      ['tasks', 23, 23],
      ['nodeRuns', 115, 115],
      ['nodeRunEvents', 361, 361],
      ['webhookDeliveries', 11, 11],
    ])
    const child = await harness.db.select().from(tasks).where(eq(tasks.id, 'perftask0000009')).get()
    expect(child?.executionLineageId).toBe('perftask0000008')
    expect(child?.lineageSlotPathJson).toBe(
      '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"perftask0000008","workflowRevision":null},{"stableNodeKey":"child-task","frozenOccurrenceKey":"perftask0000009","workflowRevision":null}]',
    )
    const run = await harness.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, 'perfrun00000000'))
      .get()
    expect(run).toMatchObject({
      continuationSlotKey: null,
      lineageSlotPathJson: null,
      scopePath: '',
      reviewIteration: 0,
    })
  })

  test('the reusable entry preserves existing database-default workflow timestamps', async () => {
    await seedPerformanceCorpusEntry({ db: harness.db, session: harness.session })
    const original = await harness.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, 'perf-wf'))
      .get()
    expect(original?.createdAt).toBeGreaterThan(0)
    expect(original?.updatedAt).toBeGreaterThan(0)
    await harness.db
      .update(workflows)
      .set({ createdAt: 123_456, updatedAt: 234_567 })
      .where(eq(workflows.id, 'perf-wf'))
      .run()
    await seedPerformanceCorpus({ db: harness.db, session: harness.session, dimensions: TINY })
    const restored = await harness.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, 'perf-wf'))
      .get()
    expect(restored?.createdAt).toBe(123_456)
    expect(restored?.updatedAt).toBe(234_567)
  })

  test('actual inserts obey provider batch budgets and receipt reads use bounded keyset pages', async () => {
    const dimensions = { ...TINY, tasks: 503, runsPerTask: 1, events: 503 }
    const recording = harness.recordStatements()
    try {
      const receipt = await seedPerformanceCorpus({
        db: harness.db,
        session: harness.session,
        dimensions,
      })
      expect(receipt.matchesExpected).toBe(true)
      const inserts = recording.statements.filter((item) => /^insert\s+into\b/i.test(item.sql))
      expect(inserts.every((item) => item.params <= harness.capabilities.maxBindParameters)).toBe(
        true,
      )
      for (const [name, table, total] of [
        ['cached_repos', cachedRepos, dimensions.repos],
        ['tasks', tasks, dimensions.tasks],
        ['node_runs', nodeRuns, dimensions.tasks],
        ['node_run_events', nodeRunEvents, dimensions.events],
        ['webhook_deliveries', webhookDeliveries, dimensions.deliveries],
      ] as const) {
        const statements = inserts.filter((item) => item.sql.includes(`"${name}"`))
        const max = harness.capabilities.batchInsertMax(Object.keys(getTableColumns(table)).length)
        expect(statements.length).toBe(Math.ceil(total / max))
      }
      const eventInserts = inserts.filter((item) => item.sql.includes('"node_run_events"'))
      expect(eventInserts.length).toBeGreaterThan(1)
      expect(recording.selects().every((item) => item.rows <= 500)).toBe(true)
      expect(recording.selects().some((item) => item.sql.includes(' > '))).toBe(true)
    } finally {
      recording.stop()
    }
  })

  test('a later real FK failure rolls back the whole event chunk and keeps earlier committed phases', async () => {
    const dimensions = { ...TINY, tasks: 503, runsPerTask: 1, events: 503 }
    const recording = harness.recordStatements()
    try {
      await expect(
        seedPerformanceCorpus({
          db: harness.db,
          session: harness.session,
          dimensions,
          onProgress: async (item) => {
            if (item.table === 'nodeRuns') {
              await harness.session.transaction(async (tx) => {
                await tx.delete(nodeRuns).where(eq(nodeRuns.id, 'perfrun00000502')).run()
              })
            }
          },
        }),
      ).rejects.toThrow()
      // Index 502 is in the second actual INSERT batch; the first 500 rows
      // already executed in this same transaction before the missing FK fails.
      const firstEventInsert = recording.statements.find(
        (item) => /^insert\s+into\b/i.test(item.sql) && item.sql.includes('"node_run_events"'),
      )
      expect(
        firstEventInsert?.values.filter((value) => value === perfEventRow(0, dimensions).payload)
          .length,
      ).toBe(500)
      expect(await harness.db.select({ count: count() }).from(nodeRunEvents).get()).toEqual({
        count: 0,
      })
      expect(await harness.db.select({ count: count() }).from(tasks).get()).toEqual({ count: 503 })
      expect(await harness.db.select({ count: count() }).from(nodeRuns).get()).toEqual({
        count: 502,
      })
      expect(await harness.db.select({ count: count() }).from(cachedRepos).get()).toEqual({
        count: 7,
      })
      expect(await harness.db.select({ count: count() }).from(webhookDeliveries).get()).toEqual({
        count: 0,
      })
    } finally {
      recording.stop()
    }
  })

  test('nested real transaction rollback includes every phase and receipt reads its own writes', async () => {
    const failure = new Error('roll back the completed tiny corpus')
    await expect(
      harness.session.transaction(async (tx) => {
        const receipt = await seedPerformanceCorpus({
          db: harness.db,
          session: harness.session,
          dimensions: TINY,
        })
        expect(receipt.matchesExpected).toBe(true)
        expect(await tx.select({ count: count() }).from(nodeRunEvents).get()).toEqual({
          count: 361,
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await harness.db.select({ count: count() }).from(tasks).get()).toEqual({ count: 0 })
    expect(await harness.db.select({ count: count() }).from(cachedRepos).get()).toEqual({
      count: 0,
    })
    expect(await harness.db.select({ count: count() }).from(nodeRunEvents).get()).toEqual({
      count: 0,
    })
    expect(
      await harness.db.select().from(workflows).where(eq(workflows.id, 'perf-wf')).get(),
    ).toBeUndefined()
  })

  test('reseed retains old insert-ignore rows but appends database-generated event IDs', async () => {
    await seedPerformanceCorpus({ db: harness.db, session: harness.session, dimensions: TINY })
    const second = await seedPerformanceCorpus({
      db: harness.db,
      session: harness.session,
      dimensions: TINY,
    })
    expect(second.actualCounts).toEqual({ ...second.expectedCounts, nodeRunEvents: 722 })
    expect(second.actualDigests.tasks).toBe(OLD_NATIVE_DIGESTS.tasks)
    expect(second.actualDigests.nodeRuns).toBe(OLD_NATIVE_DIGESTS.nodeRuns)
    expect(second.matchesExpected).toBe(false)
    const appended = await harness.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.id, 362))
      .get()
    expect(appended).toMatchObject({ id: 362, ...perfEventRow(0, TINY) })
  })

  test('receipt includes unrelated existing rows instead of hiding them with a corpus prefix', async () => {
    await seedPerformanceCorpus({ db: harness.db, session: harness.session, dimensions: TINY })
    await harness.db
      .insert(cachedRepos)
      .values({
        id: 'ordinary-existing-repo',
        urlHash: 'ordinary-existing-hash',
        localPath: '/ordinary-repo',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    const receipt = await readPerformanceCorpusReceipt(harness.db, TINY)
    expect(receipt.actualCounts.cachedRepos).toBe(8)
    expect(receipt.actualDigests.cachedRepos).not.toBe(OLD_NATIVE_DIGESTS.cachedRepos)
    expect(receipt.matchesExpected).toBe(false)
  })
})
