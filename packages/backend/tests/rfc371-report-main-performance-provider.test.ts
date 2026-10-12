// RFC-371: diagnose the serving-thread transfer/publication separately from the
// original Worker without changing complete counts, CNY facts or failure results.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationReportRows,
  observationReportCounts,
  observationReportPages,
  observationReportReceipts,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import { completeReportPerformanceObserver } from '@/modules/run-observability/infrastructure/completeReportPerformanceObserver'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

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

describeEachProvider('RFC-371 original report main-stage diagnostics', (harness) => {
  for (const mode of ['measured', 'ordinary', 'factory-failed', 'logger-failed'] as const) {
    test(`the ${mode} observer retains all original published facts and every physical count`, async () => {
      await seedCompleteTask(harness, 1, 2)
      const binding = harness.applicationBinding,
        source =
          binding.provider === 'sqlite'
            ? { ...binding, generationId: 'original-main-performance-generation' }
            : { provider: 'postgresql' as const, runtime: binding.runtime }
      const cache = completeObservationReportCache(
        harness.db,
        source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
        createCompleteTaskObservationFacts,
      )
      const folder = mkdtempSync(join(tmpdir(), 'aw-original-main-performance-')),
        spool = completeObservationFileSpool(folder),
        phases: string[] = [],
        diagnosticFailure = new Error('Original diagnostic unavailable')
      let clock = 0,
        factoryCalls = 0,
        buildCalls = 0,
        publishCalls = 0,
        stagedPages = 0
      const service = completeObservationReportService({
        store: {
          ...cache,
          async stageBatch(id, owner, pages) {
            stagedPages += pages.length
            return cache.stageBatch(id, owner, pages)
          },
          async publish(id, owner, manifest) {
            publishCalls++
            return cache.publish(id, owner, manifest)
          },
        },
        spool,
        owner: randomUUID(),
        heartbeatDuringRead: false,
        scopeOf: completeObservationActorScope,
        keyOf: sha256Hex,
        newId: randomUUID,
        observePhase(report) {
          factoryCalls++
          if (mode === 'factory-failed') throw diagnosticFailure
          return completeReportPerformanceObserver(report.id, report.request.refreshKey, {
            now: () => ++clock,
            emit: (sample) => {
              expect(sample.reportId).toBe(report.id)
              phases.push(sample.phase)
              if (mode === 'logger-failed') throw diagnosticFailure
            },
          })
        },
        build(report, signal) {
          buildCalls++
          return originalReportSnapshotSession(source).run(
            (snapshot) =>
              composeCompleteObservationSnapshot({
                snapshot,
                tasks: createCompleteTaskObservationFacts(snapshot.executor),
                report,
                spool,
                signal,
              }),
            signal,
          )
        },
      })
      try {
        const requested = await service.request(
          actor,
          { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' },
          mode === 'ordinary' ? 'ordinary-main-performance' : 'load-performance-main-' + mode,
        )
        const id = requested.state === 'ready' ? requested.header.reportId : requested.reportId
        await service.worker.drain()
        const original = await cache.get(id)
        expect(original?.report.state).toBe('ready')
        if (original?.report.state !== 'ready' || !original.manifest)
          throw new Error('Original complete main-stage report did not publish')
        expect(factoryCalls).toBe(1)
        expect(buildCalls).toBe(1)
        expect(publishCalls).toBe(1)
        expect(String(stagedPages)).toBe(original.manifest.pages)
        expect(original.report.summary.inventory).toEqual({
          tasks: '1',
          attempts: '1',
          invocations: '1',
          numericRecords: '2',
          nativeCaptures: '1',
        })
        expect(original.report.summary.metrics).toEqual({
          state: 'ready',
          invocations: '1',
          observedInvocations: '1',
          records: '2',
          tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
          cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
        })
        for (const [key, table] of [
          ['rows', observationReportRows],
          ['counts', observationReportCounts],
          ['pages', observationReportPages],
          ['receipts', observationReportReceipts],
        ] as const) {
          const rows = await harness.db.select().from(table).where(eq(table.reportId, id)).all()
          expect(String(rows.length)).toBe(original.manifest[key])
        }
        const counts = await harness.db
          .select()
          .from(observationReportCounts)
          .where(eq(observationReportCounts.reportId, id))
          .all()
        const rows = await harness.db
          .select()
          .from(observationReportRows)
          .where(eq(observationReportRows.reportId, id))
          .all()
        for (const count of counts) {
          expect(count.declared).toBe(true)
          expect(count.actual).toBe(count.total)
          expect(
            String(
              rows.filter((row) => row.section === count.section && row.parent === count.parent)
                .length,
            ),
          ).toBe(count.total)
        }
        if (mode === 'ordinary' || mode === 'factory-failed') expect(phases).toEqual([])
        else {
          expect(phases[0]).toBe('main-job-started')
          expect(phases).toContain('main-inputs-qualified')
          expect(phases).toContain('main-build-returned')
          expect(phases).toContain('main-transfer-opened')
          expect(phases.filter((phase) => phase === 'main-stage-started').length).toBeGreaterThan(0)
          expect(phases.filter((phase) => phase === 'main-stage-finished').length).toBe(
            phases.filter((phase) => phase === 'main-stage-started').length,
          )
          expect(phases).toContain('main-transfer-staged')
          expect(phases).toContain('main-publish-qualified')
          expect(phases).toContain('main-published')
          expect(phases.at(-1)).toBe('main-job-finished')
        }
      } finally {
        await service.worker.stop()
        rmSync(folder, { recursive: true, force: true })
      }
    }, 60_000)
  }

  test('a diagnostic failure preserves the original build failure and publishes no numeric rows', async () => {
    await seedCompleteTask(harness, 1, 2)
    const folder = mkdtempSync(join(tmpdir(), 'aw-original-main-failure-')),
      spool = completeObservationFileSpool(folder),
      cache = completeObservationReportCache(
        harness.db,
        'original-main-failure-generation',
        createCompleteTaskObservationFacts,
      ),
      originalFailure = new Error('Original report read failed'),
      phases: string[] = []
    let buildCalls = 0,
      publishCalls = 0
    const service = completeObservationReportService({
      store: {
        ...cache,
        async publish(id, owner, manifest) {
          publishCalls++
          return cache.publish(id, owner, manifest)
        },
      },
      spool,
      owner: randomUUID(),
      heartbeatDuringRead: false,
      scopeOf: completeObservationActorScope,
      keyOf: sha256Hex,
      newId: randomUUID,
      observePhase: () => (phase) => {
        phases.push(phase)
        throw new Error('Diagnostic output failed')
      },
      async build() {
        buildCalls++
        throw originalFailure
      },
    })
    try {
      const requested = await service.request(
        actor,
        { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' },
        'load-performance-main-original-failure',
      )
      const id = requested.state === 'ready' ? requested.header.reportId : requested.reportId
      await service.worker.drain()
      const stored = await cache.get(id)
      expect(stored?.report).toMatchObject({ state: 'failed', error: originalFailure.message })
      expect(buildCalls).toBe(1)
      expect(publishCalls).toBe(0)
      expect(phases).not.toContain('main-build-returned')
      expect(phases).not.toContain('main-published')
      expect(phases.at(-1)).toBe('main-job-finished')
      for (const table of [
        observationReportRows,
        observationReportCounts,
        observationReportPages,
        observationReportReceipts,
      ])
        expect(
          await harness.db.select().from(table).where(eq(table.reportId, id)).all(),
        ).toHaveLength(0)
    } finally {
      await service.worker.stop()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
