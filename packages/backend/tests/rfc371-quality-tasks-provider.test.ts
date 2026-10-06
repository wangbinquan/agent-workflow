// Original Task gaps, not globally redacted metrics, choose each complete affected-Task population.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  tasks,
  nodeRuns,
  observationUsageCaptures,
  observationUsageCurrent,
  observationReportRows,
  observationReports,
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
  CompleteObservationQuality,
  CompleteObservationTask,
  CompleteObservationReportPage,
  CompleteObservationMetrics,
} from '@agent-workflow/shared'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
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

describeEachProvider('RFC-371 original gap Task index', (harness) => {
  test('201 missing-invocation Tasks and overlapping gaps keep exact independent parent counts through EOF', async () => {
    await seedCompleteTask(harness, 1, 1)
    const original = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'complete-original-task'))
      .get()
    const attempt = await harness.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
      .get()
    if (!original || !attempt) throw new Error('Original gap fixture missing')
    const expected = Array.from({ length: 201 }, (_, n) => 'gap-task-' + String(n).padStart(4, '0'))
    for (let start = 0; start < expected.length; start += 50) {
      const ids = expected.slice(start, start + 50)
      await harness.db
        .insert(tasks)
        .values(ids.map((id) => ({ ...original, id, name: id, rootTaskId: id })))
        .run()
      await harness.db
        .insert(nodeRuns)
        .values(ids.map((id) => ({ ...attempt, id: id + '-attempt', taskId: id })))
        .run()
    }
    // The one original accepted call has two independent gaps; neither reason changes the other population.
    await harness.db
      .delete(observationUsageCaptures)
      .where(eq(observationUsageCaptures.invocationId, completeFixtureId('invocation', 0)))
      .run()
    await harness.db
      .delete(observationUsageCurrent)
      .where(eq(observationUsageCurrent.taskId, original.id))
      .run()
    const root = mkdtempSync(join(tmpdir(), 'aw-original-gap-index-'))
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'original-gap-tasks' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const spool = completeObservationFileSpool(root),
      cache = completeObservationReportCache(
        harness.db,
        source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
      )
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
              tasks: createCompleteTaskObservationFacts(snapshot.executor, report.request.taskId),
              report,
              spool,
              signal,
            }),
          signal,
        ),
    })
    try {
      const accepted = await service.request(
        actor,
        { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' },
        'original-gap-tasks',
      )
      const id = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
      await service.worker.drain()
      const report = await service.status(actor, id)
      expect(report.state).toBe('not-ready')
      if (report.state !== 'not-ready' || !report.facts)
        throw new Error('Original sealed execution facts missing')
      expect(report.facts.summary.inventory).toEqual({
        tasks: '202',
        attempts: '202',
        invocations: '1',
      })
      const quality = await service.page<CompleteObservationQuality>(actor, id, {
        section: 'quality',
        limit: 37,
      })
      const counts = new Map(quality.items.map((row) => [row.key, row.taskCount]))
      expect(counts.get('invocation-unobserved')).toBe('201')
      expect(counts.get('native-capture-unobserved')).toBe('1')
      expect(counts.get('usage-unobserved')).toBe('1')
      const independentMetrics = new Map<string, CompleteObservationMetrics>()
      for (const task of [original.id, expected[0]!]) {
        const accepted = await service.request(
          actor,
          { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' },
          'original-gap-tasks',
          task,
        )
        const independentId =
          accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
        await service.worker.drain()
        const independent = await service.status(actor, independentId)
        if (independent.state !== 'not-ready' || !independent.facts)
          throw new Error('Original independent gap Task facts missing')
        expect(independent.facts.summary.inventory.tasks).toBe('1')
        expect(independent.facts.summary.metrics).toEqual({
          state: 'not-ready',
          gaps:
            task === original.id
              ? ['native-capture-unobserved', 'usage-unobserved']
              : ['invocation-unobserved'],
          tokenCoverage: {
            invocations: task === original.id ? '1' : '0',
            observedInvocations: '0',
            records: '0',
            bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
          },
        })
        expect(independent.facts.summary.metrics).not.toHaveProperty('recordedUsage')
        independentMetrics.set(task, independent.facts.summary.metrics)
      }
      for (const reason of quality.items) {
        expect(reason.taskIndexVersion).toBe(1)
        const seen: string[] = []
        let after: string | null = null
        do {
          const page: CompleteObservationReportPage<CompleteObservationTask> = await service.page(
            actor,
            id,
            {
              section: 'quality-tasks',
              parent: reason.key,
              limit: 37,
              ...(after ? { after } : {}),
            },
          )
          expect(page.total).toBe(reason.taskCount)
          for (const row of page.items) {
            seen.push(row.task.id)
            const independent = independentMetrics.get(
              row.task.id === original.id ? original.id : expected[0]!,
            )
            if (!independent) throw new Error('Original independent Task metrics missing')
            expect(row.metrics).toEqual(independent)
            expect(row.metrics).not.toHaveProperty('tokens')
            expect(row.metrics).not.toHaveProperty('cost')
          }
          after = page.nextCursor
        } while (after !== null)
        expect(BigInt(new Set(seen).size)).toBe(BigInt(reason.taskCount))
        expect(new Set(seen)).toEqual(
          reason.key === 'invocation-unobserved' ? new Set(expected) : new Set([original.id]),
        )
      }
      expect(new Set(expected).has(original.id)).toBe(false)
      // Preserve an original pre-index quality row; direct callers cannot receive a fabricated zero.
      const reason = quality.items.find((row) => row.key === 'invocation-unobserved')!
      const { taskIndexVersion: _index, ...legacyQuality } = reason
      // Construct the original pre-index shape during building, then publish its unchanged legacy row.
      const originalState = await harness.db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, id))
        .get()
      if (!originalState) throw new Error('Original report state missing')
      await harness.db
        .update(observationReports)
        .set({ state: 'building' })
        .where(eq(observationReports.id, id))
        .run()
      await harness.db
        .update(observationReportRows)
        .set({ document: JSON.stringify(legacyQuality) })
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.section, 'quality'),
            eq(observationReportRows.key, reason.key),
          ),
        )
        .run()
      await harness.db
        .update(observationReports)
        .set({ state: originalState.state })
        .where(eq(observationReports.id, id))
        .run()
      await expect(
        service.page(actor, id, { section: 'quality-tasks', parent: reason.key, limit: 37 }),
      ).rejects.toThrow('Original quality Task index was not sealed')
      await expect(
        service.page(actor, id, { section: 'quality-tasks', limit: 37 }),
      ).rejects.toThrow('Original quality reason is required')
      const retainedQuality = await service.page<CompleteObservationQuality>(actor, id, {
        section: 'quality',
        limit: 37,
      })
      expect(retainedQuality.items.find((row) => row.key === reason.key)).toEqual(legacyQuality)
      expect(legacyQuality.taskCount).toBe('201')
      await harness.db
        .update(observationReportRows)
        .set({ document: JSON.stringify(reason) })
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.section, 'quality'),
            eq(observationReportRows.key, reason.key),
          ),
        )
        .run()
      await expect(service.page(actor, id, { section: 'quality', limit: 37 })).rejects.toThrow(
        'retained output differs',
      )
    } finally {
      await service.worker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
})
