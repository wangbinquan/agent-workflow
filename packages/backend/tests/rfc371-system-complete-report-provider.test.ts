// RFC-371: real System groups passed the source query but were rejected by the
// report cache and publication's Task-only join. Keep admission, full retained
// population and partial known Token/CNY readable without synthetic Task rows.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type {
  CompleteObservationTask,
  CompleteObservationAttempt,
  CompleteObservationDimension,
  CompleteObservationInvocation,
  ObservationMeasurement,
} from '@agent-workflow/shared'
import { completeObservationReportContent } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { tasks, users, taskExecutionOwners } from '@/db/schema'
import { systemAgentObservationOwners } from '@/db/observationSystem'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { composeTaskObservations } from '@/modules/run-observability/composition/taskObservations'
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
    async publish(taskId?: string, refreshKey: string = randomUUID()) {
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
        expect(published.content.summary.timing).toMatchObject({
          runningMs: null,
          runningCoverage: { tasks: '1', observedTasks: '0' },
        })
        expect(published.content.summary.timing).not.toHaveProperty('recordedRunningMs')
        expect(published.content.summary.rootTask).toMatchObject({
          task: { runningMs: null, runningSince: null },
          timing: {
            wallMs: '499',
            runningMs: null,
            intervals: {
              state: 'complete',
              cumulativeMs: '997',
              activeUnionMs: '499',
              unknown: '0',
            },
          },
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
        const agents = await original.service.page<CompleteObservationDimension>(
          actor,
          published.id,
          { section: 'agents', limit: 1 },
        )
        expect(agents.total).toBe('1')
        expect(agents.nextCursor).toBeNull()
        expect(agents.items[0]).toMatchObject({
          label: 'aw-memory-distiller',
          selection: { agent: { id: 'system-agent:aw-memory-distiller', revision: null } },
          metrics: {
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
          },
        })
        const calls: CompleteObservationInvocation[] = []
        after = undefined
        for (;;) {
          const page: Awaited<
            ReturnType<typeof original.service.page<CompleteObservationInvocation>>
          > = await original.service.page<CompleteObservationInvocation>(actor, published.id, {
            section: 'invocations',
            limit: 1,
            ...(after ? { after } : {}),
          })
          expect(page.total).toBe('2')
          calls.push(...page.items)
          if (page.nextCursor === null) break
          after = page.nextCursor
        }
        expect(calls).toHaveLength(2)
        for (const call of calls) {
          expect(call.agentId).toBe('system-agent:aw-memory-distiller')
          expect(call.agentName).toBe('aw-memory-distiller')
        }
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
        expect(published.content.summary.timing).toMatchObject({
          runningMs: null,
          runningCoverage: { tasks: '203', observedTasks: '1' },
          recordedRunningMs: '3',
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
        expect(linked.content.summary.timing).toMatchObject({
          runningMs: null,
          runningCoverage: { tasks: '2', observedTasks: '1' },
          recordedRunningMs: '3',
        })
        expect(linked.content.summary.rootTask?.timing.runningMs).toBe('3')
        const linkedRows = await original.service.page<CompleteObservationTask>(actor, linked.id, {
          section: 'tasks',
          limit: 19,
        })
        expect<Set<string | undefined>>(
          new Set(linkedRows.items.map((row) => row.task.id)),
        ).toEqual(new Set(['complete-original-task', ids[201]]))
        expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([
          { id: 'complete-original-task' },
        ])
      } finally {
        await original.close()
      }
    }, 120000)

    test('four original retry owners retain long waiting gaps, known Task zero and unknown boundaries without a System state clock', async () => {
      await seedCompleteTask(harness, 1, 2)
      const observations = composeLocalInvocationObservations(
        harness.db,
        composeObservationUsageSource(harness.db),
      )
      const factory = composeSystemAgentObservations({ db: harness.db, observations })
      const intervals = [
        [0, 5985],
        [51266, 8230],
        [122227, 6948],
        [8230238, 61738],
      ] as const
      const owners: string[] = []
      let taskId = ''
      for (const [index, [offset, duration]] of intervals.entries()) {
        const run = await factory.open({
          feature: 'memory-distiller',
          agentName: 'aw-memory-distiller',
          protocol: 'opencode',
          startedAt: COMPLETE_NOW + offset,
          demand: {
            kind: 'memory-distill',
            originalId: 'original-retry-time-job',
            originalAttempt: `${index + 1}:0`,
            name: 'Original retry time',
            ownerUserId: actor.user.id,
            purpose: 'memory',
          },
        })
        taskId = run.taskId
        owners.push(run.invocationId)
        await run.accept({})
        await run.settle(index === 3 ? 'ok' : 'exit-nonzero', COMPLETE_NOW + offset + duration)
      }
      const original = reports(harness)
      try {
        const scope = completeObservationActorScope(actor),
          refreshKey = 'original-system-running-state',
          legacy = await original.cache.ensure(
            { actor, query, refreshKey, taskId },
            sha256Hex(
              JSON.stringify([
                2,
                'scope-metrics/12',
                original.cache.generation,
                scope,
                query,
                taskId,
                refreshKey,
              ]),
            ),
            scope,
            'original-system-wall-alias',
            randomUUID(),
          )
        await original.cache.unavailable(legacy.id, legacy.owner, ['original-running-wall-alias'])
        const legacyReport = (await original.cache.get(legacy.id))!.report
        const published = await original.publish(taskId, refreshKey)
        expect(published.id).not.toBe(legacy.id)
        expect((await original.cache.get(legacy.id))!.report).toEqual(legacyReport)
        expect(published.content.summary.inventory).toMatchObject({
          tasks: '1',
          attempts: '4',
          invocations: '4',
        })
        expect(published.content.summary.timing).toMatchObject({
          wallMs: '8291976',
          runningMs: null,
          runningCoverage: { tasks: '1', observedTasks: '0' },
          unknown: '0',
        })
        expect(published.content.summary.timing).not.toHaveProperty('recordedRunningMs')
        expect(published.content.summary.rootTask?.timing).toEqual({
          wallMs: '8291976',
          runningMs: null,
          range: { from: COMPLETE_NOW, to: COMPLETE_NOW + 8291976 },
          intervals: {
            state: 'complete',
            cumulativeMs: '82901',
            activeUnionMs: '82901',
            unknown: '0',
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
          expect(page.total).toBe('4')
          attempts.push(...page.items)
          if (page.nextCursor === null) break
          after = page.nextCursor
        }
        expect(new Set(attempts.map((row) => row.id))).toEqual(new Set(owners))
        const byRetry = [...attempts].sort((a, b) => a.retryIndex - b.retryIndex)
        expect(byRetry.map((row) => row.durationMs)).toEqual(['5985', '8230', '6948', '61738'])
        expect(byRetry.map((row) => row.status)).toEqual(['failed', 'failed', 'failed', 'done'])
        const bounded = composeTaskObservations({
          db: harness.db,
          taskSource: createCompleteTaskObservationFacts,
          now: () => COMPLETE_NOW + 8291977,
        })
        const detail = await bounded.detail(actor, taskId)
        expect(detail?.runningMs).toBeNull()
        expect(detail?.wallMs).toBe(8291976)
        expect(detail?.intervals.activeUnionMs).toBe(82901)

        const mixed = await original.publish()
        expect(mixed.content.summary.timing).toMatchObject({
          runningMs: null,
          runningCoverage: { tasks: '2', observedTasks: '1' },
          recordedRunningMs: '3',
        })
        const ordinary = await original.publish('complete-original-task')
        expect(ordinary.content.summary.timing.runningMs).toBe('3')
        expect(ordinary.content.summary.timing).not.toHaveProperty('runningCoverage')
        expect(ordinary.content.summary.timing).not.toHaveProperty('recordedRunningMs')
        await harness.db
          .update(tasks)
          .set({ runningMs: 0 })
          .where(eq(tasks.id, 'complete-original-task'))
          .run()
        const knownZero = await original.publish()
        expect(knownZero.content.summary.timing).toMatchObject({
          runningMs: null,
          runningCoverage: { tasks: '2', observedTasks: '1' },
          recordedRunningMs: '0',
        })
        await harness.db
          .update(systemAgentObservationOwners)
          .set({ finishedAt: null })
          .where(eq(systemAgentObservationOwners.id, owners[3]!))
          .run()
        const unknown = await original.publish(taskId)
        expect(unknown.content.summary.rootTask?.timing).toMatchObject({
          wallMs: '8291976',
          runningMs: null,
          intervals: { state: 'not-ready', unknown: '1' },
        })
        await harness.db
          .update(systemAgentObservationOwners)
          .set({ finishedAt: COMPLETE_NOW + 8291976 })
          .where(eq(systemAgentObservationOwners.id, owners[3]!))
          .run()
        const liveStartedAt = Date.now() - 1000
        const live = await factory.open({
          feature: 'memory-distiller',
          agentName: 'aw-memory-distiller',
          protocol: 'opencode',
          startedAt: liveStartedAt,
          demand: {
            kind: 'memory-distill',
            originalId: 'original-retry-time-job',
            originalAttempt: '5:0',
            name: 'Original retry time',
            ownerUserId: actor.user.id,
            purpose: 'memory',
          },
        })
        await live.accept({})
        const open = await original.publish(taskId)
        const openDuration = open.content.header.asOf - liveStartedAt
        expect(open.content.summary.inventory).toMatchObject({ attempts: '5', invocations: '5' })
        expect(open.content.summary.rootTask).toMatchObject({
          task: { runningMs: null, runningSince: null, finishedAt: null },
          timing: {
            runningMs: null,
            wallMs: String(open.content.header.asOf - COMPLETE_NOW),
            intervals: {
              state: 'complete',
              cumulativeMs: String(82901 + openDuration),
              activeUnionMs: String(82901 + openDuration),
              unknown: '0',
            },
          },
        })
        await live.settle('aborted', Date.now())
        expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([
          { id: 'complete-original-task' },
        ])
      } finally {
        await original.close()
      }
    }, 60000)
  },
)
