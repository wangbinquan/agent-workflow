import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
  observationReportRows,
  nodeRuns,
  tasks,
  taskExecutionObservationSources,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { sumCnyAmounts } from '@/modules/run-observability/domain/cnyPricing'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import {
  completeReportFactRow,
  completeReportFactSummary,
} from '@/modules/run-observability/domain/completeReportFacts'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import { completeMetricsFold } from '@/modules/run-observability/domain/completeMetricsFold'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationTask,
  type CompleteObservationReport,
  type CompleteObservationReportPage,
  type CompleteObservationMetrics,
  type CompleteObservationDimension,
  type CompleteObservationTrend,
  type CompleteObservationReportSummary,
  type ObservationSpanDetail,
} from '@agent-workflow/shared'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
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
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' }
const reportId = (report: CompleteObservationReport) =>
  report.state === 'ready' ? report.header.reportId : report.reportId

describeEachProvider('RFC-371 complete execution facts without numeric subtotals', (harness) => {
  test('one missing native capture cannot hide another Task whose complete four buckets and CNY match its own lifecycle report', async () => {
    await seedCompleteTask(harness, 1, 2)
    const original = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'complete-original-task'))
      .get()
    const accepted = await harness.db
      .select()
      .from(observationInvocations)
      .where(eq(observationInvocations.id, completeFixtureId('invocation', 0)))
      .get()
    const attempt = await harness.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
      .get()
    if (!original || !accepted || !attempt) throw new Error('Original complete Task inputs missing')
    const missingTaskId = 'original-missing-capture-task',
      missingRunId = 'original-missing-capture-run'
    await harness.db
      .insert(tasks)
      .values({
        ...original,
        id: missingTaskId,
        rootTaskId: missingTaskId,
        name: 'Original Task with missing native capture',
      })
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({ ...attempt, id: missingRunId, taskId: missingTaskId })
      .run()
    const missingInvocation = {
      ...JSON.parse(accepted.document),
      invocationId: 'original-missing-capture-invocation',
      taskId: missingTaskId,
      nodeRunId: missingRunId,
      agentId: 'missing-capture-agent',
      purpose: 'system',
    }
    missingInvocation.authority = {
      ...missingInvocation.authority,
      runtime: {
        ...missingInvocation.authority.runtime,
        registrationId: 'missing-capture-runtime',
        acceptedName: 'Missing capture runtime',
      },
    }
    await harness.db
      .insert(observationInvocations)
      .values({
        ...accepted,
        id: missingInvocation.invocationId,
        taskId: missingTaskId,
        canonicalExecution: sha256Hex(JSON.stringify(['local', missingInvocation.invocationId])),
        document: JSON.stringify(missingInvocation),
        fingerprint: JSON.stringify(missingInvocation),
      })
      .run()
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'original-independent-task-scope' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const cache = completeObservationReportCache(
      harness.db,
      source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
    )
    const folder = mkdtempSync(join(tmpdir(), 'aw-independent-task-scope-')),
      spool = completeObservationFileSpool(folder)
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
      const refreshKey = 'independent-complete-task-scope'
      // The exact historical request key must stay immutable after the rendering qualification changes.
      const oldKey = sha256Hex(
        JSON.stringify([
          2,
          cache.generation,
          completeObservationActorScope(actor),
          query,
          null,
          refreshKey,
        ]),
      )
      const old = await cache.ensure(
        { actor, query, refreshKey },
        oldKey,
        completeObservationActorScope(actor),
        'historical-original-owner',
        randomUUID(),
      )
      await cache.unavailable(old.id, old.owner, ['historical-whole-scope-redaction'])
      const oldReport = (await cache.get(old.id))!.report
      const id = reportId(await service.request(actor, query, refreshKey))
      expect(id).not.toBe(old.id)
      await service.worker.drain()
      expect((await cache.get(old.id))!.report).toEqual(oldReport)
      const report = await service.status(actor, id)
      if (report.state !== 'not-ready' || !report.facts)
        throw new Error('Complete mixed population missing')
      expect(report.facts.summary.inventory).toEqual({
        tasks: '2',
        attempts: '2',
        invocations: '2',
      })
      expect(report.facts.summary.usageCoverage).toEqual({
        readyTasks: '1',
        missingTasks: '1',
        notApplicableTasks: '0',
      })
      expect(report.facts.summary.metrics).toEqual({
        state: 'not-ready',
        gaps: ['native-capture-unobserved', 'usage-unobserved'],
        costCoverage: { records: '2', pricedRecords: '2', visibility: 'visible' },
        tokenCoverage: {
          invocations: '2',
          observedInvocations: '1',
          records: '2',
          bucketRecords: { input: '2', cacheRead: '2', cacheWrite: '2', output: '2' },
        },
        recordedUsage: {
          invocations: '2',
          observedInvocations: '1',
          records: '2',
          bucketRecords: { input: '2', cacheRead: '2', cacheWrite: '2', output: '2' },
          tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
        },
        recordedCost: { currency: 'CNY', amount: '0.00015', records: '2', pricedRecords: '2' },
      })
      expect(report.facts.summary.metrics).not.toHaveProperty('tokens')
      expect(report.facts.summary.metrics).not.toHaveProperty('cost')
      const page = await service.page<CompleteObservationTask>(actor, id, {
        section: 'tasks',
        limit: 1,
      })
      expect(page.total).toBe('2')
      expect(page.items).toHaveLength(1)
      expect(page.nextCursor).not.toBeNull()
      const last = await service.page<CompleteObservationTask>(actor, id, {
        section: 'tasks',
        limit: 1,
        after: page.nextCursor!,
      })
      expect(last.total).toBe('2')
      expect(last.items).toHaveLength(1)
      expect(last.nextCursor).toBeNull()
      const rows = [...page.items, ...last.items]
      expect(new Set(rows.map((row) => row.task.id))).toEqual(new Set([original.id, missingTaskId]))
      const complete = rows.find((row) => row.task.id === original.id)!,
        missing = rows.find((row) => row.task.id === missingTaskId)!
      expect(complete.metrics).toEqual({
        state: 'ready',
        invocations: '1',
        observedInvocations: '1',
        records: '2',
        tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
        cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
      })
      expect(missing.metrics).toEqual({
        state: 'not-ready',
        gaps: report.facts.summary.metrics.gaps,
        tokenCoverage: {
          invocations: '1',
          observedInvocations: '0',
          records: '0',
          bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
        },
      })
      expect(missing.metrics).not.toHaveProperty('tokens')
      expect(missing.metrics).not.toHaveProperty('cost')
      const lifecycleId = reportId(
        await service.request(actor, query, 'same-complete-task-lifecycle', original.id),
      )
      await service.worker.drain()
      const lifecycle = await service.status(actor, lifecycleId)
      if (lifecycle.state !== 'ready')
        throw new Error('Original complete Task lifecycle lost its numeric qualification')
      expect(complete.metrics).toEqual(lifecycle.summary.metrics)
      expect(lifecycle.summary.inventory.tasks).toBe('1')
      const missingLifecycleId = reportId(
        await service.request(actor, query, 'same-missing-task-lifecycle', missingTaskId),
      )
      await service.worker.drain()
      const missingLifecycle = await service.status(actor, missingLifecycleId)
      if (missingLifecycle.state !== 'not-ready' || !missingLifecycle.facts)
        throw new Error('Original missing Task lifecycle evidence lost')
      expect(missing.metrics).toEqual(missingLifecycle.facts.summary.metrics)
      for (const section of [
        'agents',
        'runtimes',
        'models',
        'purposes',
        'sources',
        'trends',
        'attempts',
        'invocations',
      ] as const) {
        type Scope = {
          key?: string
          id?: string
          invocationId?: string
          metrics: CompleteObservationMetrics
        }
        const group = await service.page<Scope>(actor, id, { section, limit: 100 }),
          own = await service.page<Scope>(actor, lifecycleId, { section, limit: 100 }),
          other = await service.page<Scope>(actor, missingLifecycleId, { section, limit: 100 })
        expect(group.nextCursor).toBeNull()
        expect(own.nextCursor).toBeNull()
        expect(other.nextCursor).toBeNull()
        const key = (row: Scope) => row.key ?? row.id ?? row.invocationId
        for (const row of group.items) {
          const ready = own.items.find((candidate) => key(candidate) === key(row)),
            gap = other.items.find((candidate) => key(candidate) === key(row))
          expect(ready ?? gap).toBeDefined()
          if (ready && gap) {
            const expected = emptyCompleteObservationFold()
            mergeCompleteObservationFold(expected, completeMetricsFold(ready.metrics))
            mergeCompleteObservationFold(expected, completeMetricsFold(gap.metrics))
            expect(row.metrics).toEqual(completeObservationMetrics(expected))
          } else expect(row.metrics).toEqual(gap ? gap.metrics : ready!.metrics)
        }
        if (['agents', 'runtimes', 'purposes', 'attempts', 'invocations'].includes(section)) {
          expect(group.items.some((row) => row.metrics.state === 'ready')).toBe(true)
          expect(group.items.some((row) => row.metrics.state === 'not-ready')).toBe(true)
        }
      }
      for (const section of ['agents', 'runtimes', 'models', 'purposes', 'sources'] as const) {
        const dimensions = await service.page<CompleteObservationDimension>(actor, id, {
          section,
          limit: 100,
        })
        for (const dimension of dimensions.items) {
          const members = await service.page<CompleteObservationTask>(actor, id, {
            section: 'dimension-tasks',
            parent: dimension.key,
            limit: 100,
          })
          expect(members.nextCursor).toBeNull()
          expect(members.total).toBe(dimension.taskCount)
          for (const member of members.items)
            expect(member.metrics).toEqual(
              member.task.id === original.id ? lifecycle.summary.metrics : missing.metrics,
            )
        }
      }
      for (const invalid of [
        {
          ...complete.metrics,
          tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '47' },
        },
        { ...missing.metrics, tokens: { input: '0' } },
        { state: 'not-applicable', tokens: { total: '0' } },
      ])
        expect(() =>
          completeReportFactRow(
            {
              section: 'tasks',
              parent: null,
              key: original.id,
              document: { ...complete, metrics: invalid },
            },
            report.facts!.summary.metrics.gaps,
          ),
        ).toThrow('metrics are not qualified')
      const readyStored = await harness.db
        .select()
        .from(observationReportRows)
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.section, 'tasks'),
            eq(observationReportRows.key, original.id),
          ),
        )
        .get()
      if (!readyStored) throw new Error('Original ready retained Task missing')
      await harness.db
        .update(observationReportRows)
        .set({
          document: JSON.stringify({
            ...complete,
            metrics: { ...missing.metrics, tokens: { total: '48' } },
          }),
        })
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.ordinal, readyStored.ordinal),
          ),
        )
        .run()
      await expect(service.page(actor, id, { section: 'tasks' })).rejects.toThrow(
        'retained output differs',
      )
      await harness.db
        .update(observationReportRows)
        .set({ document: readyStored.document })
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.ordinal, readyStored.ordinal),
          ),
        )
        .run()
      const retained = await harness.db
        .select()
        .from(observationReportRows)
        .where(
          and(eq(observationReportRows.reportId, id), eq(observationReportRows.section, 'tasks')),
        )
        .get()
      if (!retained) throw new Error('Original retained Task scope missing')
      await harness.db
        .delete(observationReportRows)
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.ordinal, retained.ordinal),
          ),
        )
        .run()
      await expect(service.status(actor, id)).rejects.toThrow('retained output differs')
      await expect(service.page(actor, id, { section: 'tasks' })).rejects.toThrow(
        'retained output differs',
      )
    } finally {
      await service.worker.stop()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 120000)
  test('202 original Tasks and every invocation survive incomplete usage; only qualified scope metrics are retained and damaged facts are rejected', async () => {
    await seedCompleteTask(harness, 3, 3)
    await harness.db
      .delete(observationUsageCaptures)
      .where(eq(observationUsageCaptures.invocationId, completeFixtureId('invocation', 2)))
      .run()
    const unknownModel = await harness.db
      .select()
      .from(observationUsageCurrent)
      .where(
        eq(
          observationUsageCurrent.id,
          sha256Hex(
            JSON.stringify([
              'complete-native-source',
              completeFixtureId('invocation', 2),
              completeFixtureId('meter', 2),
            ]),
          ),
        ),
      )
      .get()
    if (!unknownModel) throw new Error('Original unknown model fixture missing')
    const unknownDocument = JSON.parse(unknownModel.document)
    unknownDocument.measurement.model = null
    await harness.db
      .update(observationUsageCurrent)
      .set({ document: JSON.stringify(unknownDocument) })
      .where(eq(observationUsageCurrent.id, unknownModel.id))
      .run()
    const original = await harness.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'complete-original-task'))
      .get()
    if (!original) throw new Error('Original Task fixture missing')
    for (let offset = 0; offset < 201; offset += 50)
      await harness.db
        .insert(tasks)
        .values(
          Array.from({ length: Math.min(50, 201 - offset) }, (_, i) => {
            const id = 'fact-task-' + String(offset + i).padStart(4, '0')
            return { ...original, id, name: id, rootTaskId: id, workflowSnapshot: '{}' }
          }),
        )
        .run()
    const accepted = await harness.db
      .select()
      .from(observationInvocations)
      .where(eq(observationInvocations.id, completeFixtureId('invocation', 0)))
      .get()
    if (!accepted) throw new Error('Original accepted invocation missing')
    const spanOwner = {
      ...JSON.parse(accepted.document),
      spanCaptureContract: 'runtime-span-facts-v1',
      spanCaptureSource: 'retained-facts-source',
    }
    await harness.db
      .update(observationInvocations)
      .set({ document: JSON.stringify(spanOwner), fingerprint: JSON.stringify(spanOwner) })
      .where(eq(observationInvocations.id, accepted.id))
      .run()
    await harness.db
      .insert(taskExecutionObservationSources)
      .values({
        taskId: original.id,
        nodeRunId: completeFixtureId('run', 0),
        pending: false,
        evidenceJson: JSON.stringify({
          invocationId: completeFixtureId('invocation', 0),
          measurements: [],
          diagnostics: [],
          spanFacts: [
            {
              schemaVersion: 1,
              invocationId: completeFixtureId('invocation', 0),
              spanKey: 'retained-model-step',
              scope: {
                sourceNamespace: 'retained-facts-source',
                rootSessionId: 'root-0',
                nativeSessionId: 'root-0',
                parentNativeSessionId: null,
                ancestors: [],
                callId: 'call-0',
                kind: 'model',
              },
              label: 'Actual retained model step',
              parentCallId: null,
              model: { provider: 'native', id: 'actual' },
              measurementRecordId: completeFixtureId('meter', 0),
              state: {
                startedAt: COMPLETE_NOW,
                endedAt: COMPLETE_NOW + 10,
                nativeObservedAt: COMPLETE_NOW + 10,
                status: 'success',
              },
              capturedAt: COMPLETE_NOW + 10,
            },
          ],
        }),
      })
      .run()
    const binding = harness.applicationBinding
    const source =
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'original-complete-facts' }
        : { provider: 'postgresql' as const, runtime: binding.runtime }
    const cache = completeObservationReportCache(
      harness.db,
      source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
    )
    const folder = mkdtempSync(join(tmpdir(), 'aw-complete-facts-')),
      spool = completeObservationFileSpool(folder)
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
      const id = reportId(await service.request(actor, query, 'mixed-original-facts'))
      await service.worker.drain()
      const report = await service.status(actor, id)
      expect(report.state).toBe('not-ready')
      if (report.state !== 'not-ready' || !report.facts)
        throw new Error('Original complete facts missing')
      expect(report.facts.summary.inventory).toEqual({
        tasks: '202',
        attempts: '3',
        invocations: '3',
      })
      expect(report.facts.summary.usageCoverage).toEqual({
        readyTasks: '0',
        missingTasks: '1',
        notApplicableTasks: '201',
      })
      expect(report.facts.summary.metrics.state).toBe('not-ready')
      const independent = await buildOriginalCompleteTask(harness, 3)
      expect(independent.summary.metrics.state).toBe('not-ready')
      expect(independent.allocations).toHaveLength(3)
      const tokens = {
        input: '0',
        cacheRead: '0',
        cacheWrite: '0',
        output: '0',
        total: '0',
      }
      for (const allocation of independent.allocations)
        for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
          expect(allocation.contribution[bucket]).not.toBeNull()
          tokens[bucket] = String(
            BigInt(tokens[bucket]) + BigInt(String(allocation.contribution[bucket])),
          )
        }
      tokens.total = String(
        BigInt(tokens.input) +
          BigInt(tokens.cacheRead) +
          BigInt(tokens.cacheWrite) +
          BigInt(tokens.output),
      )
      const trend = await service.page<CompleteObservationTrend>(actor, id, {
        section: 'trends',
        limit: 1,
      })
      expect(trend.total).toBe('1')
      expect(trend.nextCursor).toBeNull()
      expect(trend.items[0]!.metrics.state).toBe('not-ready')
      expect(trend.items[0]!.recordedUsage).toEqual({
        invocations: '3',
        observedInvocations: '3',
        records: '3',
        tokens,
      })
      expect(report.facts.summary.recordedUsage).toEqual(trend.items[0]!.recordedUsage)
      expect(report.facts.summary.recordedUsage!.tokens.total).not.toBe('48')
      const pricedAllocations = independent.allocations.filter(
        (allocation) =>
          allocation.cost.complete && !allocation.cost.hidden && allocation.cost.amount !== null,
      )
      expect(pricedAllocations.length).toBeGreaterThan(0)
      expect(report.facts.summary.metrics.recordedCost).toEqual({
        currency: 'CNY',
        amount: sumCnyAmounts(pricedAllocations.map((allocation) => allocation.cost.amount!)),
        records: String(independent.allocations.length),
        pricedRecords: String(pricedAllocations.length),
      })
      expect(trend.items[0]!.metrics).toEqual(report.facts.summary.metrics)
      expect(tokens).toEqual({
        input: '6',
        cacheRead: '18',
        cacheWrite: '30',
        output: '42',
        total: '96',
      })
      // Even the Task and its third invocation are not ready: all their received records count.
      expect(report.facts.summary.usageCoverage!.readyTasks).toBe('0')
      expect(trend.items[0]!.recordedUsage!.tokens.total).not.toBe('48')
      expect(report.facts.summary.metrics).not.toHaveProperty('tokens')
      expect(report.facts.summary.metrics).not.toHaveProperty('cost')
      expect(
        Object.keys(report.facts.counts).every((key) =>
          COMPLETE_OBSERVATION_FACT_SECTIONS.includes(
            key as (typeof COMPLETE_OBSERVATION_FACT_SECTIONS)[number],
          ),
        ),
      ).toBe(true)
      const seen: string[] = []
      let after: string | null = null
      do {
        const page: CompleteObservationReportPage<CompleteObservationTask> = await service.page(
          actor,
          id,
          { section: 'tasks', limit: 100, ...(after ? { after } : {}) },
        )
        expect(page.total).toBe('202')
        for (const row of page.items) {
          seen.push(row.task.id)
          if (row.task.id === original.id) expect(row.metrics).toEqual(report.facts.summary.metrics)
          else expect(row.metrics).toEqual({ state: 'not-applicable' })
          expect(row.metrics).not.toHaveProperty('tokens')
          expect(row.metrics).not.toHaveProperty('cost')
        }
        after = page.nextCursor
      } while (after !== null)
      expect(new Set(seen).size).toBe(202)
      expect(seen).toContain('fact-task-0200')
      for (const section of [
        'invocations',
        'attempts',
        'agents',
        'runtimes',
        'models',
        'purposes',
        'sources',
        'trends',
      ] as const) {
        const page = await service.page<{
          id?: string
          invocationId?: string
          selection?: CompleteObservationDimension['selection']
          metrics: CompleteObservationMetrics
        }>(actor, id, { section, limit: 100 })
        expect(page.items.length).toBeGreaterThan(0)
        for (const row of page.items) {
          if (section === 'invocations' || section === 'attempts') {
            const missing =
              (row.invocationId ?? row.id) ===
              completeFixtureId(section === 'invocations' ? 'invocation' : 'run', 2)
            expect(row.metrics.state).toBe(missing ? 'not-ready' : 'ready')
            if (!missing && row.metrics.state === 'ready') {
              expect(row.metrics.invocations).toBe('1')
              expect(row.metrics.observedInvocations).toBe('1')
              expect(row.metrics.tokens.total).toBe(
                (row.invocationId ?? row.id) ===
                  completeFixtureId(section === 'invocations' ? 'invocation' : 'run', 0)
                  ? '16'
                  : '32',
              )
            }
          } else if (section === 'models') {
            expect(row.metrics.state).toBe(
              row.selection?.model?.model === 'actual' ? 'ready' : 'not-ready',
            )
            if (row.metrics.state === 'ready') expect(row.metrics.tokens.total).toBe('48')
          } else expect(row.metrics.state).toBe('not-ready')
        }
      }
      for (const section of [
        'allocations',
        'native-captures',
        'platform-captures',
        'span-captures',
        'receipts',
      ])
        await expect(service.page(actor, id, { section })).rejects.toThrow(
          'numeric evidence is incomplete',
        )
      const selectedId = reportId(
        await service.request(
          actor,
          {
            ...query,
            selection: JSON.stringify({
              model: { authority: 'local', sourceId: null, provider: 'native', model: 'actual' },
            }),
          },
          'unknown-model-population',
        ),
      )
      await service.worker.drain()
      const selected = await service.status(actor, selectedId)
      expect(selected.state).toBe('not-ready')
      if (selected.state === 'not-ready') expect(selected.facts).toBeUndefined()
      const taskId = reportId(
        await service.request(actor, query, 'original-task-facts', original.id),
      )
      await service.worker.drain()
      const task = await service.status(actor, taskId)
      if (task.state !== 'not-ready' || !task.facts) throw new Error('Original Task facts missing')
      expect(task.facts.summary.rootTask?.metrics).toEqual(task.facts.summary.metrics)
      const spans = await service.page<ObservationSpanDetail>(actor, taskId, {
        section: 'span-facts',
        parent: JSON.stringify(['attempt', completeFixtureId('run', 0)]),
      })
      expect(spans.items).toHaveLength(1)
      expect(spans.items[0]?.fact.label).toBe('Actual retained model step')
      expect(spans.items[0]?.usage).toBeNull()
      expect(spans.items[0]?.cost).toBeNull()
      const originalSpan = {
        section: 'span-facts' as const,
        parent: JSON.stringify(['attempt', completeFixtureId('run', 0)]),
        key: 'retained-model-step',
        document: spans.items[0]!,
      }
      const originalGaps = report.facts.summary.metrics.gaps
      expect(completeReportFactRow(originalSpan, originalGaps)).toEqual(originalSpan)
      expect(() =>
        completeReportFactRow(
          {
            ...originalSpan,
            document: { ...originalSpan.document, recordedUsage: trend.items[0]!.recordedUsage },
          },
          originalGaps,
        ),
      ).toThrow('recorded trend usage is not qualified')
      await expect(
        cache.page((await cache.get(id))!, {
          section: 'allocations',
          parent: null,
          after: null,
          limit: 100,
        }),
      ).rejects.toThrow('numeric evidence is incomplete')
      // A received record with an unknown bucket cannot turn that bucket into zero.
      const partialDocument = JSON.parse(JSON.stringify(unknownDocument))
      partialDocument.measurement.usage.output = null
      partialDocument.measurement.coverage = 'partial'
      partialDocument.contribution.output = null
      partialDocument.complete = false
      await harness.db
        .update(observationUsageCurrent)
        .set({ document: JSON.stringify(partialDocument) })
        .where(eq(observationUsageCurrent.id, unknownModel.id))
        .run()
      const partialId = reportId(
        await service.request(actor, query, 'received-unknown-output-bucket'),
      )
      await service.worker.drain()
      const partial = await service.status(actor, partialId)
      if (partial.state !== 'not-ready' || !partial.facts)
        throw new Error('Original partial record facts missing')
      expect(partial.facts.summary.inventory).toEqual(report.facts.summary.inventory)
      const partialTrend = await service.page<CompleteObservationTrend>(actor, partialId, {
        section: 'trends',
        limit: 1,
      })
      expect(partialTrend.total).toBe('1')
      expect(partialTrend.nextCursor).toBeNull()
      expect(partialTrend.items[0]!.metrics.state).toBe('not-ready')
      if (partialTrend.items[0]!.metrics.state === 'not-ready')
        expect(partialTrend.items[0]!.metrics.gaps).toContain('usage-incomplete')
      expect(partialTrend.items[0]).not.toHaveProperty('recordedUsage')
      expect(partial.facts.summary).not.toHaveProperty('recordedUsage')
      expect(partial.facts.summary.metrics).not.toHaveProperty('tokens')
      expect(partial.facts.summary.metrics).not.toHaveProperty('cost')
      const retained = await harness.db
        .select()
        .from(observationReportRows)
        .where(
          and(eq(observationReportRows.reportId, id), eq(observationReportRows.section, 'tasks')),
        )
        .get()
      if (!retained) throw new Error('Original retained fact missing')
      await harness.db
        .delete(observationReportRows)
        .where(
          and(
            eq(observationReportRows.reportId, id),
            eq(observationReportRows.ordinal, retained.ordinal),
          ),
        )
        .run()
      await expect(service.status(actor, id)).rejects.toThrow('retained output differs')
      await expect(service.page(actor, id, { section: 'tasks' })).rejects.toThrow(
        'retained output differs',
      )
    } finally {
      await service.worker.stop()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 120000)
})

test('recorded trend qualification keeps unknown buckets unknown and rejects fabricated coverage or totals', () => {
  const fold = emptyCompleteObservationFold('2')
  addCompleteObservationAllocation(
    fold,
    { input: '1', cacheRead: '3', cacheWrite: '5', output: '7' },
    { amount: null, complete: false, hidden: false },
  )
  fold.observedInvocations = '1'
  completeObservationGap(fold, 'usage-unobserved')
  const recorded = {
    invocations: '2',
    observedInvocations: '1',
    records: '1',
    tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
  }
  const row = {
    section: 'trends' as const,
    parent: null,
    key: 'original-day',
    document: {
      key: 'original-day',
      from: 0,
      to: 1,
      tasks: '2',
      metrics: completeObservationMetrics(fold),
      recordedUsage: recorded,
    },
  }
  expect(completeReportFactRow(row, fold.gaps)).toEqual(row)
  const summary: CompleteObservationReportSummary = {
    metrics: row.document.metrics,
    recordedUsage: recorded,
    inventory: {
      tasks: '2',
      attempts: '2',
      invocations: '2',
      numericRecords: '1',
      nativeCaptures: '1',
    },
    statuses: { done: '2' },
    timing: { wallMs: '1', runningMs: '1', p50Ms: null, p95Ms: null, unknown: '0' },
    rootTask: null,
  }
  const qualifiedSummary = completeReportFactSummary(summary)
  expect(qualifiedSummary.recordedUsage).toEqual(recorded)
  expect(qualifiedSummary.inventory).toEqual({ tasks: '2', attempts: '2', invocations: '2' })
  expect(qualifiedSummary.metrics).not.toHaveProperty('tokens')
  expect(qualifiedSummary.metrics).not.toHaveProperty('cost')
  expect(completeReportFactSummary(qualifiedSummary)).toEqual(qualifiedSummary)
  const { recordedUsage: _recordedUsage, ...legacySummary } = summary
  expect(_recordedUsage).toEqual(recorded)
  expect(completeReportFactSummary(legacySummary)).not.toHaveProperty('recordedUsage')
  for (const inventory of [
    { ...summary.inventory, invocations: '3' },
    { ...summary.inventory, numericRecords: '2' },
  ])
    expect(() => completeReportFactSummary({ ...summary, inventory })).toThrow(
      'recorded summary usage is not qualified',
    )
  const partial = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(
    partial,
    { input: '10', cacheRead: '0', cacheWrite: '0', output: null },
    { amount: null, complete: false, hidden: false },
  )
  partial.observedInvocations = '1'
  expect(partial.gaps).toContain('usage-incomplete')
  for (const invalid of [
    { ...row, section: 'agents' as const },
    { ...row, document: { ...row.document, metrics: completeObservationMetrics(partial) } },
    {
      ...row,
      document: {
        ...row.document,
        metrics: completeObservationMetrics({ ...fold, invocations: '1', gaps: [] }),
      },
    },
    ...[
      { ...recorded, records: '0' },
      { ...recorded, observedInvocations: '0' },
      { ...recorded, observedInvocations: '3' },
      { ...recorded, invocations: '02' },
      { ...recorded, cost: { currency: 'CNY', amount: '0' } },
      { ...recorded, tokens: { ...recorded.tokens, output: null } },
      { ...recorded, tokens: { ...recorded.tokens, total: '15' } },
    ].map((recordedUsage) => ({ ...row, document: { ...row.document, recordedUsage } })),
  ]) {
    expect(() => completeReportFactRow(invalid, fold.gaps)).toThrow(
      'recorded trend usage is not qualified',
    )
    if (invalid.section === 'trends')
      expect(() =>
        completeReportFactSummary({
          ...summary,
          metrics: invalid.document.metrics,
          recordedUsage: invalid.document.recordedUsage,
        } as CompleteObservationReportSummary),
      ).toThrow()
  }
})
