// RFC-371: real System groups passed the source query but were rejected by the
// report cache and publication's Task-only join. Keep admission, full retained
// population and partial known Token/CNY readable without synthetic Task rows.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CompleteObservationTask,
  CompleteObservationAttempt,
  ObservationMeasurement,
} from '@agent-workflow/shared'
import { completeObservationReportContent } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { tasks, users, taskExecutionOwners } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'

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
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }

function reports(harness: ProviderHarness) {
  const binding = harness.applicationBinding
  const source =
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'original-system-report-reader' }
      : { provider: 'postgresql' as const, runtime: binding.runtime }
  const generation =
    source.provider === 'sqlite' ? source.generationId : source.runtime.generationId
  const appHome = mkdtempSync(join(tmpdir(), 'aw-system-complete-report-'))
  const spool = completeObservationFileSpool(appHome)
  const cache = completeObservationReportCache(
    harness.db,
    generation,
    createCompleteTaskObservationFacts,
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
  return {
    service,
    cache,
    async publish(taskId?: string, refreshKey = randomUUID()) {
      const requested = await service.request(actor, query, refreshKey, taskId)
      const id = requested.state === 'ready' ? requested.header.reportId : requested.reportId
      await service.worker.drain()
      const original = await service.status(actor, id)
      const content = completeObservationReportContent(original)
      if (!content) throw new Error('Original System report facts were not published')
      return { id, original, content }
    },
    async close() {
      await service.worker.stop()
      rmSync(appHome, { recursive: true, force: true })
    },
  }
}

describeEachProvider(
  'RFC-371 original System complete report admission and population',
  (harness) => {
    test('standalone System retry admits without a Task row and retains every one of 214 known records', async () => {
      await harness.db.insert(users).values({
        ...actor.user,
        passwordHash: 'fixture',
        forcePasswordChange: false,
        createdAt: COMPLETE_NOW,
        updatedAt: COMPLETE_NOW,
      })
      const observations = composeLocalInvocationObservations(
        harness.db,
        composeObservationUsageSource(harness.db),
      )
      const factory = composeSystemAgentObservations({ db: harness.db, observations })
      let taskId: string | undefined
      for (const [attempt, records] of [
        [1, 211],
        [2, 3],
      ] as const) {
        const run = await factory.open({
          feature: 'memory-distiller',
          agentName: 'aw-memory-distiller',
          protocol: 'opencode',
          startedAt: COMPLETE_NOW + attempt,
          demand: {
            kind: 'memory-distill',
            originalId: 'original-standalone-job',
            originalAttempt: `${attempt}:${attempt - 1}`,
            name: 'Original standalone memory',
            ownerUserId: actor.user.id,
            purpose: 'memory',
          },
        })
        if (taskId !== undefined) expect(run.taskId).toBe(taskId)
        taskId = run.taskId
        await run.accept({})
        await run.append(
          Array.from({ length: records }, (_, n) => ({
            invocationId: run.invocationId,
            measurements: [
              {
                schemaVersion: 1,
                invocationId: run.invocationId,
                taskId: run.taskId,
                nodeRunId: run.nodeRunId,
                agentId: run.agentId,
                recordId: `original-system-${attempt}-${n}`,
                revision: 1,
                occurredAt: COMPLETE_NOW + attempt,
                observedAt: COMPLETE_NOW + attempt,
                model: null,
                adapterVersion: 'original-system-report-stream-fixture',
                reporting: 'delta',
                inclusion: 'self',
                coverage: 'complete',
                validity: 'valid',
                basis: { kind: 'invocation' },
                usage: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
              } satisfies ObservationMeasurement,
            ],
            diagnostics: [],
          })),
        )
        await run.reconcile()
        await run.settle('ok', COMPLETE_NOW + 500)
      }
      const original = reports(harness)
      try {
        const published = await original.publish(taskId)
        expect(published.original.state).toBe('not-ready')
        expect(published.content.summary.inventory).toMatchObject({
          tasks: '1',
          attempts: '2',
          invocations: '2',
        })
        expect(published.content.summary.metrics).toMatchObject({
          state: 'not-ready',
          recordedUsage: {
            records: '214',
            tokens: {
              input: '214',
              cacheRead: '428',
              cacheWrite: '642',
              output: '856',
              total: '2140',
            },
          },
        })
        const attempts: CompleteObservationAttempt[] = []
        let after: string | undefined
        for (;;) {
          const page = await original.service.page<CompleteObservationAttempt>(
            actor,
            published.id,
            {
              section: 'attempts',
              limit: 1,
              ...(after ? { after } : {}),
            },
          )
          expect(page.total).toBe('2')
          attempts.push(...page.items)
          if (page.nextCursor === null) break
          after = page.nextCursor
        }
        expect(attempts.map((row) => [row.retryIndex, row.iteration])).toEqual([
          [1, 0],
          [2, 1],
        ])
        expect(await harness.db.select().from(tasks)).toEqual([])
        expect(await harness.db.select().from(taskExecutionOwners)).toEqual([])
      } finally {
        await original.close()
      }
    }, 60000)

    test('203 mixed sources qualify past the scheduling batch and linked Task detail keeps its System descendant', async () => {
      await seedCompleteTask(harness, 1, 2)
      const observations = composeLocalInvocationObservations(
        harness.db,
        composeObservationUsageSource(harness.db),
      )
      const factory = composeSystemAgentObservations({ db: harness.db, observations })
      const ids = []
      for (let n = 0; n < 202; n++) {
        const run = await factory.open({
          feature: 'memory-distiller',
          agentName: 'aw-memory-distiller',
          protocol: 'opencode',
          startedAt: COMPLETE_NOW + n,
          demand: {
            kind: 'memory-distill',
            originalId: `original-mixed-job-${n}`,
            originalAttempt: '1:0',
            name: `Original memory ${n}`,
            ownerUserId: actor.user.id,
            ...(n === 201 ? { parentTaskId: 'complete-original-task' } : {}),
            purpose: 'memory',
          },
        })
        await run.accept({})
        await run.settle('ok', COMPLETE_NOW + 1000)
        ids.push(run.taskId)
      }
      const original = reports(harness)
      try {
        const refreshKey = 'original-mixed-system-report'
        const scope = completeObservationActorScope(actor)
        const legacy = await original.cache.ensure(
          { actor, query, refreshKey },
          sha256Hex(
            JSON.stringify([
              2,
              'scope-metrics/8',
              original.cache.generation,
              scope,
              query,
              null,
              refreshKey,
            ]),
          ),
          scope,
          'original-task-only-qualifier',
          randomUUID(),
        )
        await original.cache.unavailable(legacy.id, legacy.owner, [
          'original-system-population-not-qualified',
        ])
        const published = await original.publish(undefined, refreshKey)
        expect(published.id).not.toBe(legacy.id)
        expect((await original.cache.get(legacy.id))?.report).toEqual({
          state: 'not-ready',
          reportId: legacy.id,
          gaps: ['original-system-population-not-qualified'],
        })
        expect(published.content.summary.inventory).toMatchObject({
          tasks: '203',
          attempts: '203',
          invocations: '203',
        })
        expect(published.content.summary.metrics).toMatchObject({
          state: 'not-ready',
          recordedUsage: {
            records: '2',
            tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
          },
          recordedCost: { currency: 'CNY', amount: '0.00015', records: '2', pricedRecords: '2' },
        })
        const retained: CompleteObservationTask[] = []
        let after: string | undefined
        for (;;) {
          const page = await original.service.page<CompleteObservationTask>(actor, published.id, {
            section: 'tasks',
            limit: 19,
            ...(after ? { after } : {}),
          })
          expect(page.total).toBe('203')
          retained.push(...page.items)
          if (page.nextCursor === null) break
          after = page.nextCursor
        }
        expect(new Set(retained.map((row) => row.task.id))).toEqual(
          new Set(['complete-original-task', ...ids]),
        )
        expect(await original.service.status(actor, published.id)).toEqual(published.original)
        const linked = await original.publish('complete-original-task')
        expect(linked.content.summary.inventory).toMatchObject({
          tasks: '2',
          attempts: '2',
          invocations: '2',
        })
        const linkedRows = await original.service.page<CompleteObservationTask>(actor, linked.id, {
          section: 'tasks',
          limit: 19,
        })
        expect(new Set(linkedRows.items.map((row) => row.task.id))).toEqual(
          new Set(['complete-original-task', ids[201]]),
        )
        expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([
          { id: 'complete-original-task' },
        ])
      } finally {
        await original.close()
      }
    }, 120000)
  },
)
