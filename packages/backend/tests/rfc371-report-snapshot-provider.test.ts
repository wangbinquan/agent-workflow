// RFC-371: the original pool or original SQLite channel owns every input/TEMP read.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { ReportWorkspace, ReportWorkingPage } from '@/platform/persistence/reportWorkspace'

test('an unsupported report provider cannot silently select another implementation', () => {
  expect(() => originalReportSnapshotSession({ provider: 'unsupported' } as never)).toThrow(
    'unhandled database provider: unsupported',
  )
})

describeEachProvider('original complete report snapshot', (harness) => {
  test('concurrent reports and an original owner transaction retain independent private rows', async () => {
    await harness.executeFixtureDdl(
      'CREATE TABLE rfc371_original_report_queue (id text PRIMARY KEY,value text NOT NULL)',
    )
    await harness.db.run(sql`INSERT INTO rfc371_original_report_queue VALUES('stable','original')`)
    const binding = { ...harness.applicationBinding, generationId: 'original-test-generation' }
    const session = originalReportSnapshotSession(binding)
    const work = (key: string) =>
      session.run(async ({ workspace, executor, snapshotId }) => {
        expect(await workspace.page('queue', null)).toEqual({ items: [], nextCursor: null })
        await workspace.insert('queue', [{ key, document: key }])
        expect(await workspace.page('queue', null)).toEqual({
          items: [{ key, document: key }],
          nextCursor: null,
        })
        expect(
          await executor.all(sql`SELECT value FROM rfc371_original_report_queue WHERE id='stable'`),
        ).toEqual([{ value: 'original' }])
        return snapshotId
      })
    const [first, second] = await Promise.all([work('first'), work('second')])
    expect(first).not.toBe(second)
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const owner = harness.session.transaction(async (tx) => {
      await tx.run(sql`INSERT INTO rfc371_original_report_queue VALUES('writer','committed')`)
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const queued = Promise.all([work('third'), work('fourth')])
    release.resolve()
    await owner
    const [third, fourth] = await queued
    expect(new Set([first, second, third, fourth]).size).toBe(4)
    await session.run(async ({ workspace, executor }) => {
      expect(await workspace.page('queue', null)).toEqual({ items: [], nextCursor: null })
      expect(
        await executor.all(sql`SELECT value FROM rfc371_original_report_queue WHERE id='writer'`),
      ).toEqual([{ value: 'committed' }])
    })
  }, 30000)
  test('a concurrent failure or cancellation cannot leave private rows in the next report', async () => {
    const binding = { ...harness.applicationBinding, generationId: 'original-test-generation' }
    const session = originalReportSnapshotSession(binding)
    for (const mode of ['failure', 'cancellation'] as const) {
      const controller = new AbortController()
      const failed = session.run(async ({ workspace }) => {
        await workspace.insert('discarded', [{ key: mode, document: mode }])
        if (mode === 'cancellation') controller.abort(new Error('original job cancelled'))
        else throw new Error('original job failed')
      }, controller.signal)
      const next = session.run(async ({ workspace }) => {
        expect(await workspace.page('discarded', null)).toEqual({ items: [], nextCursor: null })
        await workspace.insert('discarded', [{ key: 'next', document: 'next' }])
      })
      const results = await Promise.allSettled([failed, next])
      expect(results[0].status).toBe('rejected')
      expect(results[1].status).toBe('fulfilled')
      await session.run(async ({ workspace }) => {
        expect(await workspace.page('discarded', null)).toEqual({ items: [], nextCursor: null })
      })
    }
  }, 30000)
  test('10001 private rows retain every original ordinal and return the reservation after EOF', async () => {
    await harness.executeFixtureDdl(
      'CREATE TABLE rfc371_original_report_input (id text PRIMARY KEY,value text NOT NULL)',
    )
    await harness.db.run(sql`INSERT INTO rfc371_original_report_input VALUES('original','before')`)
    const binding = { ...harness.applicationBinding, generationId: 'original-test-generation' }
    const session = originalReportSnapshotSession(binding)
    let retained: ReportWorkspace | undefined
    const snapshotId = await session.run(async (snapshot) => {
      retained = snapshot.workspace
      expect(
        await snapshot.executor.all(sql`SELECT value FROM rfc371_original_report_input`),
      ).toEqual([{ value: 'before' }])
      for (let offset = 0; offset < 10001; offset += 500)
        await snapshot.workspace.insert(
          'original-rows',
          Array.from({ length: Math.min(500, 10001 - offset) }, (_, i) => ({
            key: String(offset + i).padStart(8, '0'),
            document: { ordinal: String(offset + i), bins: ['1', '2', '3', '4'] },
          })),
        )
      let cursor: string | null = null,
        count = 0
      for (;;) {
        const page: ReportWorkingPage<{ ordinal: string; bins: string[] }> =
          await snapshot.workspace.page('original-rows', cursor, 137)
        for (const row of page.items) {
          expect(row.key).toBe(String(count).padStart(8, '0'))
          expect(row.document).toEqual({ ordinal: String(count++), bins: ['1', '2', '3', '4'] })
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      expect(count).toBe(10001)
      await snapshot.workspace.upsert('control', [
        { key: 'one', document: 'first' },
        { key: 'two', document: 'unchanged' },
      ])
      await snapshot.workspace.upsert('control', [{ key: 'one', document: 'second' }])
      expect(await snapshot.workspace.get<string>('control', 'one')).toBe('second')
      expect(await snapshot.workspace.get<string>('control', 'two')).toBe('unchanged')
      let rejectedWrite: unknown
      try {
        await snapshot.executor.run(sql`UPDATE rfc371_original_report_input SET value='forbidden'`)
      } catch (error) {
        rejectedWrite = error
      }
      expect(rejectedWrite).toBeInstanceOf(Error)
      let boundary = rejectedWrite as Error
      while (boundary.cause instanceof Error) boundary = boundary.cause
      expect(boundary.message).toBe('Report input only supports original reads')
      return snapshot.snapshotId
    })
    await expect(retained!.page('original-rows', null)).rejects.toThrow('closed')
    await session.run(async (snapshot) => {
      expect(snapshot.snapshotId).not.toBe(snapshotId)
      expect(await snapshot.workspace.page('original-rows', null)).toEqual({
        items: [],
        nextCursor: null,
      })
      expect(
        await snapshot.executor.all(sql`SELECT value FROM rfc371_original_report_input`),
      ).toEqual([{ value: 'before' }])
    })
  }, 60000)
  test('duplicate, invalid, source and interruption errors discard the job and allow a fresh whole snapshot', async () => {
    const binding = { ...harness.applicationBinding, generationId: 'original-test-generation' }
    const session = originalReportSnapshotSession(binding)
    await expect(
      session.run(async ({ workspace }) =>
        workspace.insert('duplicates', [
          { key: 'same', document: 1 },
          { key: 'same', document: 2 },
        ]),
      ),
    ).rejects.toThrow()
    await expect(
      session.run(async ({ workspace }) => workspace.insert('bad', [{ key: '', document: 1 }])),
    ).rejects.toThrow('invalid')
    await expect(
      session.run(async ({ executor }) =>
        executor.all(sql`SELECT value FROM rfc371_missing_original_source`),
      ),
    ).rejects.toThrow()
    const controller = new AbortController()
    await expect(
      session.run(async ({ workspace }) => {
        await workspace.insert('one', [{ key: 'row', document: 1 }])
        controller.abort(new Error('original source interrupted'))
      }, controller.signal),
    ).rejects.toThrow('interrupted')
    await session.run(async ({ workspace }) => {
      expect(await workspace.page('one', null)).toEqual({ items: [], nextCursor: null })
    })
  }, 30000)
})
