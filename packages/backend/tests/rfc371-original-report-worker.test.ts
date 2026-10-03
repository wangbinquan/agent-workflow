// RFC-371: actual Worker success/cancellation and real max=1 reserved-channel cleanup are hosted gates.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { observationReportBuild } from '@/platform/background/observationReportBuild'
import { runObservationReportWorker } from '@/platform/background/observationReportWorkerHost'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { composeCompleteObservationReports } from '@/modules/run-observability/composition/completeObservationReports'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { COMPLETE_NOW } from './helpers/rfc371CompleteTaskFixture'
import {
  originalWorkerFixture,
  type ReportCleanupFault,
} from './helpers/rfc371OriginalWorkerFixture'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'complete-task-reader',
    username: 'complete-task-reader',
    displayName: 'Complete reader',
    role: 'admin',
    status: 'active',
  },
})
const filters = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
type Fixture = Awaited<ReturnType<typeof originalWorkerFixture>>
function reports(fixture: Fixture) {
  const bound = observationReportBuild(fixture.binding, fixture.appHome)
  return composeCompleteObservationReports({
    db: fixture.db,
    generation:
      fixture.binding.provider === 'sqlite'
        ? fixture.binding.generationId
        : fixture.binding.runtime.generationId,
    appHome: fixture.appHome,
    heartbeatDuringRead: bound.heartbeatDuringRead,
    build: (report, _spool, signal) => bound.build(report, signal),
  })
}
const idOf = (report: Awaited<ReturnType<ReturnType<typeof reports>['queries']['request']>>) =>
  report.state === 'ready' ? report.header.reportId : report.reportId

describeEachProvider('RFC-371 original live source through a real report Worker', (harness) => {
  test('all 1001 invocations and 10001 source records pass through the real Worker and retained pages', async () => {
    const fixture = await originalWorkerFixture(harness, { attempts: 1001, records: 10001 })
    const service = reports(fixture)
    try {
      const reportId = idOf(await service.queries.request(actor, filters, 'native-worker'))
      await service.worker.drain()
      const result = await service.queries.status(actor, reportId)
      expect(result.state).toBe('ready')
      if (result.state !== 'ready') throw new Error(JSON.stringify(result))
      expect(result.summary.inventory).toEqual({
        tasks: '1',
        attempts: '1001',
        invocations: '1001',
        numericRecords: '10001',
        nativeCaptures: '1001',
      })
      expect(result.summary.metrics).toEqual({
        state: 'ready',
        invocations: '1001',
        observedInvocations: '1001',
        records: '10001',
        tokens: {
          input: '50015001',
          cacheRead: '150045003',
          cacheWrite: '250075005',
          output: '350105007',
          total: '800240016',
        },
        cost: { currency: 'CNY', state: 'complete', amount: '2500.75005' },
      })
      let after: string | null = null,
        read = 0n
      do {
        const page = await service.queries.page(actor, reportId, {
          section: 'invocations',
          limit: 200,
          ...(after ? { after } : {}),
        })
        expect(page.total).toBe('1001')
        read += BigInt(page.items.length)
        after = page.nextCursor
      } while (after !== null)
      expect(read).toBe(1001n)
      expect(result.counts['allocations']).toBe('10001')
      if (fixture.binding.provider === 'postgresql') {
        const original = await fixture.binding.runtime
          .providerPool()
          .unsafe(
            "SELECT to_regclass('pg_temp.aw_report_workspace') AS temporary, current_setting('transaction_read_only') AS mode",
          )
        expect(original[0]).toEqual({ temporary: null, mode: 'off' })
        expect(fixture.events.filter((event) => event === 'reserved').length).toBeGreaterThan(0)
      }
    } finally {
      await service.worker.stop()
      await fixture.close()
    }
  }, 120000)

  for (const fault of [
    'ROLLBACK',
    'DROP TABLE',
    'pg_advisory_unlock',
  ] as const satisfies readonly ReportCleanupFault[]) {
    test(
      'native max=1 cleanup failure discards its physical reservation before a fresh complete report: ' +
        fault,
      async () => {
        if (harness.applicationBinding.provider !== 'postgresql') return
        const fixture = await originalWorkerFixture(harness, { cleanupFault: fault })
        const service = reports(fixture)
        try {
          const first = idOf(
            await service.queries.request(actor, filters, 'cleanup-fault-' + fault),
          )
          await service.worker.drain()
          const generation =
            fixture.binding.provider === 'postgresql'
              ? fixture.binding.runtime.generationId
              : fixture.binding.generationId
          const failed = await completeObservationReportCache(fixture.db, generation).get(first)
          expect(failed?.report.state).toBe('failed')
          expect(fixture.events).toContain('cleanup-fault:' + fault)
          expect(fixture.events.filter((event) => event === 'reader-physical-close')).toHaveLength(
            1,
          )
          const closeIndex = fixture.events.indexOf('reader-physical-close')
          expect(fixture.events.slice(0, closeIndex + 1)).not.toContain('reader-released')
          expect(fixture.events).not.toContain('reader-released')
          expect(
            await fixture.db.all(
              sql`SELECT to_regclass('pg_temp.aw_report_workspace') AS temporary`,
            ),
          ).toEqual([{ temporary: null }])
          const next = idOf(await service.queries.request(actor, filters, 'fresh-after-' + fault))
          await service.worker.drain()
          const ready = await service.queries.status(actor, next)
          expect(ready.state).toBe('ready')
          if (ready.state !== 'ready') throw new Error(JSON.stringify(ready))
          expect(ready.summary.metrics.state).toBe('ready')
        } finally {
          await service.worker.stop()
          await fixture.close()
        }
      },
      60000,
    )
  }

  test('Worker cancellation drains a late original RPC before releasing its reader and prevents publication', async () => {
    if (harness.applicationBinding.provider !== 'postgresql') return
    const fixture = await originalWorkerFixture(harness)
    const binding = fixture.binding
    if (binding.provider !== 'postgresql') throw new Error('Original PostgreSQL fixture required')
    const cache = completeObservationReportCache(fixture.db, binding.runtime.generationId)
    const request = { actor, query: filters, refreshKey: 'cancel-worker' }
    const report = await cache.ensure(
      request,
      sha256Hex('cancel-worker'),
      completeObservationActorScope(actor),
      'cancel-owner',
      randomUUID(),
    )
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const controller = new AbortController()
    let finished = false,
      held = false
    try {
      const work = originalReportSnapshotSession(binding).run(
        async (snapshot) => {
          const channel = snapshot.readChannel!
          const original = {
            ...snapshot,
            readChannel: {
              ...channel,
              async values(statement: string, parameters: readonly unknown[]) {
                const rows = await channel.values(statement, parameters)
                if (!held) {
                  held = true
                  entered.resolve()
                  await release.promise
                }
                return rows
              },
            },
          }
          return runObservationReportWorker(
            {
              kind: 'start',
              appHome: fixture.appHome,
              report,
              source: {
                kind: 'original-channel',
                snapshotId: snapshot.snapshotId,
                generationId: snapshot.generationId,
                asOf: snapshot.asOf,
              },
            },
            controller.signal,
            original,
          )
        },
        controller.signal,
        { id: report.id, owner: report.owner, generation: report.generation },
      )
      const completed = work.then(
        () => {
          finished = true
          return null
        },
        (error) => {
          finished = true
          return error
        },
      )
      await entered.promise
      controller.abort(new Error('original Worker stopped'))
      await Promise.resolve()
      expect(finished).toBe(false)
      expect(fixture.events).not.toContain('reader-released')
      release.resolve()
      expect(await completed).toBeInstanceOf(Error)
      expect(fixture.events).toContain('reader-released')
      expect((await cache.get(report.id))?.report.state).toBe('building')
      await cache.fail(report.id, report.owner, 'cancelled original Worker')
      const next = await originalReportSnapshotSession(binding).run(async ({ workspace }) =>
        workspace.page('cancelled', null),
      )
      expect(next).toEqual({ items: [], nextCursor: null })
    } finally {
      release.resolve()
      await fixture.close()
    }
  }, 60000)
})
