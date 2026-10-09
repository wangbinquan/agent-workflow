import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationReportRows,
  observationReportReceipts,
  observationUsageCaptures,
  tasks,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import type {
  CompleteObservationTask,
  CompleteObservationReportPage,
  CompleteObservationMetrics,
} from '@agent-workflow/shared'
import {
  COMPLETE_NOW,
  seedCompleteTask,
  completeFixtureId,
  buildOriginalCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
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

// RFC-371 known-zero-recorded-metrics: two original complete empty captures and
// one uncaptured original call must survive every retained scope, not become three zeros.
describeEachProvider('RFC-371 known empty native calls beside unknown calls', (harness) => {
  test('Task, invocation, attempt, every dimension and trend retain known zero contributions through report publication and EOF', async () => {
    await seedCompleteTask(harness, 3, 0)
    await harness.db
      .delete(observationUsageCaptures)
      .where(eq(observationUsageCaptures.invocationId, completeFixtureId('invocation', 2)))
      .run()
    const original = await buildOriginalCompleteTask(harness, 0)
    const expected = {
      state: 'not-ready',
      tokenCoverage: {
        invocations: '3',
        observedInvocations: '2',
        knownZeroInvocations: '2',
        records: '0',
        bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
      },
      recordedUsage: {
        tokens: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0', total: '0' },
      },
      recordedCost: {
        currency: 'CNY',
        amount: '0',
        records: '0',
        pricedRecords: '0',
        knownZeroCostInvocations: '2',
      },
    }
    expect(original.summary.metrics).toMatchObject(expected)
    expect(original.allocations).toHaveLength(0)
    expect(String(original.originals[0]?.records)).toBe('0')
    expect(original.sourceReceipts.every((receipt) => receipt.eof)).toBe(true)
    expect(original.attempts.map((row) => row.id).sort()).toEqual(
      [0, 1, 2].map((n) => completeFixtureId('run', n)),
    )
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'known-empty-original-generation' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const cache = completeObservationReportCache(
      harness.db,
      source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
      createCompleteTaskObservationFacts,
    )
    const folder = mkdtempSync(join(tmpdir(), 'aw-known-empty-report-'))
    const spool = completeObservationFileSpool(folder)
    const service = completeObservationReportService({
      store: cache,
      spool,
      owner: randomUUID(),
      heartbeatDuringRead: false,
      scopeOf: completeObservationActorScope,
      keyOf: sha256Hex,
      newId: randomUUID,
      build: (report, signal) =>
        originalReportSnapshotSession(source).run(
          (snapshot) =>
            composeCompleteObservationSnapshot({
              snapshot,
              tasks: createCompleteTaskObservationFacts(snapshot.executor),
              report,
              spool,
              signal,
            }),
          signal,
        ),
    })
    try {
      const actorScope = completeObservationActorScope(actor),
        refreshKey = 'known-empty-capture'
      const old = await cache.ensure(
        { actor, query, refreshKey },
        sha256Hex(
          JSON.stringify([
            2,
            'scope-metrics/11',
            cache.generation,
            actorScope,
            query,
            null,
            refreshKey,
          ]),
        ),
        actorScope,
        'original-version-eleven',
        randomUUID(),
      )
      await cache.unavailable(old.id, old.owner, ['legacy-known-empty-contribution-unavailable'])
      const retainedOld = (await cache.get(old.id))!.report
      const accepted = await service.request(actor, query, refreshKey)
      const id = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
      expect(id).not.toBe(old.id)
      await service.worker.drain()
      const report = await service.status(actor, id)
      if (report.state !== 'not-ready' || !report.facts)
        throw new Error('Original unknown call or known empty proof lost')
      expect(report.facts.summary.inventory).toMatchObject({
        tasks: '1',
        attempts: '3',
        invocations: '3',
      })
      expect(report.facts.summary.metrics).toMatchObject(expected)
      const populations: Record<string, number> = {}
      for (const section of [
        'tasks',
        'attempts',
        'invocations',
        'agents',
        'runtimes',
        'purposes',
        'sources',
        'trends',
      ] as const) {
        const rows: Array<{ metrics: CompleteObservationMetrics; recordedUsage?: unknown }> = []
        let after: string | null = null
        const cursors = new Set<string>()
        do {
          const page: CompleteObservationReportPage<{
            metrics: CompleteObservationMetrics
            recordedUsage?: unknown
          }> = await service.page(actor, id, {
            section,
            limit: 1,
            ...(after === null ? {} : { after }),
          })
          expect(page.total).toBe(report.facts.counts[section]!)
          rows.push(...page.items)
          after = page.nextCursor
          if (after !== null) {
            expect(cursors.has(after)).toBe(false)
            cursors.add(after)
          }
        } while (after !== null)
        expect(String(rows.length)).toBe(report.facts.counts[section]!)
        populations[section] = rows.length
        if (section === 'attempts' || section === 'invocations') {
          expect(rows.filter((row) => row.metrics.state === 'ready')).toHaveLength(2)
          expect(rows.filter((row) => row.metrics.state === 'not-ready')).toHaveLength(1)
          for (const row of rows) {
            if (row.metrics.state === 'ready') {
              expect(row.metrics.records).toBe('0')
              expect(row.metrics.tokens).toEqual({
                input: '0',
                cacheRead: '0',
                cacheWrite: '0',
                output: '0',
                total: '0',
              })
              expect(row.metrics.cost).toEqual({ currency: 'CNY', state: 'complete', amount: '0' })
            } else {
              expect(row.metrics).not.toHaveProperty('recordedUsage')
              expect(row.metrics).not.toHaveProperty('recordedCost')
            }
          }
        } else {
          expect(rows.length).toBeGreaterThan(0)
          for (const row of rows) expect(row.metrics).toMatchObject(expected)
        }
        // The legacy extra trend carrier still requires actual numeric records.
        if (section === 'trends') for (const row of rows) expect(row.recordedUsage).toBeUndefined()
      }
      expect(populations.tasks).toBe(1)
      expect(populations.attempts).toBe(3)
      expect(populations.invocations).toBe(3)
      expect((await cache.get(old.id))!.report).toEqual(retainedOld)
      expect(await service.status(actor, old.id)).toEqual(retainedOld)
    } finally {
      await service.worker.stop()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60000)
})
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
describeEachProvider('RFC-371 full report publication and retained pages', (harness) => {
  test('a different worker cannot advance a report phase through the shared cache/staging ownership read', async () => {
    await seedCompleteTask(harness, 1, 2)
    const cache = completeObservationReportCache(
      harness.db,
      'original-report-generation',
      createCompleteTaskObservationFacts,
    )
    const report = await cache.ensure(
      { actor, query, refreshKey: 'original-owner-phase' },
      'original-owner-phase',
      completeObservationActorScope(actor),
      'accepted-owner',
      randomUUID(),
    )
    await expect(cache.phase(report.id, 'other-worker', 'collecting')).rejects.toThrow(
      'Original complete report build ownership changed',
    )
    expect((await cache.get(report.id))?.report).toEqual(report.report)
    await cache.phase(report.id, report.owner, 'collecting')
    expect((await cache.get(report.id))?.report).toEqual({
      state: 'building',
      reportId: report.id,
      phase: 'collecting',
    })
  })
  test('202 original Tasks including internal, deleted and out-of-window descendants reconcile across every retained page', async () => {
    await seedCompleteTask(harness, 1, 2)
    const original = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'complete-original-task'))
      .get()
    if (!original) throw new Error('Original Task fixture missing')
    for (let from = 0; from < 201; from += 50)
      await harness.db
        .insert(tasks)
        .values(
          Array.from({ length: Math.min(50, 201 - from) }, (_, offset) => {
            const n = from + offset,
              id = 'retained-' + String(n).padStart(4, '0')
            return {
              ...original,
              id,
              name: 'Original task ' + n,
              workflowSnapshot: '{}',
              rootTaskId: id,
              parentTaskId: n === 0 ? original.id : null,
              startedAt: n === 0 ? COMPLETE_NOW - 1000 : COMPLETE_NOW,
              deletedAt: n === 1 ? COMPLETE_NOW : null,
              spaceKind: n === 2 ? ('internal' as const) : original.spaceKind,
            }
          }),
        )
        .run()
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'original-full-report-generation' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const generation =
      source.provider === 'sqlite' ? source.generationId : source.runtime.generationId
    const cache = completeObservationReportCache(
        harness.db,
        generation,
        createCompleteTaskObservationFacts,
      ),
      appHome = mkdtempSync(join(tmpdir(), 'aw-complete-report-'))
    const spool = completeObservationFileSpool(appHome),
      owner = randomUUID()
    const service = completeObservationReportService({
      store: cache,
      spool,
      owner,
      heartbeatDuringRead: false,
      scopeOf: completeObservationActorScope,
      keyOf: sha256Hex,
      newId: randomUUID,
      build: (report, signal) =>
        originalReportSnapshotSession(source).run(
          (snapshot) =>
            composeCompleteObservationSnapshot({
              snapshot,
              tasks: createCompleteTaskObservationFacts(snapshot.executor),
              report,
              spool,
              signal,
            }),
          signal,
        ),
    })
    try {
      const accepted = await service.request(actor, query, 'original-cohort')
      const reportId = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
      await service.worker.drain()
      const published = await cache.get(reportId)
      expect(published?.report.state).toBe('ready')
      if (!published || published.report.state !== 'ready')
        throw new Error('Original sealed report missing')
      expect(published.report.summary.inventory).toEqual({
        tasks: '202',
        attempts: '1',
        invocations: '1',
        numericRecords: '2',
        nativeCaptures: '1',
      })
      expect(published.report.summary.metrics).toEqual({
        state: 'ready',
        invocations: '1',
        observedInvocations: '1',
        records: '2',
        tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
      })
      const rows: CompleteObservationTask[] = []
      let after: string | null = null
      do {
        const page: CompleteObservationReportPage<CompleteObservationTask> =
          await service.page<CompleteObservationTask>(actor, reportId, {
            section: 'tasks',
            ...(after === null ? {} : { after }),
            limit: 100,
          })
        expect(page.total).toBe('202')
        expect(page.items.length).toBeLessThanOrEqual(100)
        rows.push(...page.items)
        after = page.nextCursor
      } while (after !== null)
      expect(new Set(rows.map((row) => row.task.id)).size).toBe(202)
      expect(rows.map((row) => row.task.id).sort()).toEqual(
        [
          original.id,
          ...Array.from({ length: 201 }, (_, n) => 'retained-' + String(n).padStart(4, '0')),
        ].sort(),
      )
      expect(rows.find((row) => row.task.id === 'retained-0000')?.task.startedAt).toBe(
        COMPLETE_NOW - 1000,
      )
      expect(published.report.counts['allocations']).toBe('2')
      const allocation = await harness.db
        .select()
        .from(observationReportRows)
        .where(
          and(
            eq(observationReportRows.reportId, reportId),
            eq(observationReportRows.section, 'allocations'),
          ),
        )
        .get()
      expect(allocation).toBeDefined()
      await harness.db
        .delete(observationReportRows)
        .where(
          and(
            eq(observationReportRows.reportId, reportId),
            eq(observationReportRows.ordinal, allocation!.ordinal),
          ),
        )
        .run()
      await expect(service.status(actor, reportId)).rejects.toThrow('retained output differs')
      await expect(service.page(actor, reportId, { section: 'tasks', limit: 100 })).rejects.toThrow(
        'retained output differs',
      )
      expect((await cache.get(reportId))?.report.state).toBe('ready')
    } finally {
      await service.worker.stop()
      rmSync(appHome, { recursive: true, force: true })
    }
  }, 120000)
  test('a missing sealed receipt rejects the report before any totals are returned', async () => {
    await seedCompleteTask(harness, 1, 1)
    const cache = completeObservationReportCache(
      harness.db,
      'original-fixture',
      createCompleteTaskObservationFacts,
    )
    const report = await cache.ensure(
      { actor, query, refreshKey: 'missing-seal' },
      'missing-seal',
      completeObservationActorScope(actor),
      randomUUID(),
      randomUUID(),
    )
    await harness.db
      .delete(observationReportReceipts)
      .where(eq(observationReportReceipts.reportId, report.id))
      .run()
    await expect(
      cache.publish(report.id, report.owner, {
        reportId: report.id,
        owner: report.owner,
        requestKey: report.requestKey,
        pages: '0',
        rows: '0',
        counts: '0',
        receipts: '1',
        digest: '0'.repeat(64),
        header: {
          reportId: report.id,
          projectionVersion: 2,
          generation: report.generation,
          snapshotId: 'original',
          asOf: COMPLETE_NOW,
          sourceRevision: 'original',
          actorScope: report.actorScope,
          authorizationRevision: '0',
          filters: query,
          taskId: null,
        },
        summary: {
          metrics: { state: 'not-applicable' },
          inventory: {
            tasks: '0',
            attempts: '0',
            invocations: '0',
            numericRecords: '0',
            nativeCaptures: '0',
          },
          statuses: {},
          timing: { p50Ms: null, p95Ms: null, wallMs: '0', runningMs: '0', unknown: '0' },
          rootTask: null,
        },
      }),
    ).rejects.toThrow('staging seal missing')
    expect((await cache.get(report.id))?.report.state).toBe('building')
  })
})
