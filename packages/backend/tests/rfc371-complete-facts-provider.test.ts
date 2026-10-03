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
  tasks,
  taskExecutionObservationSources,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationTask,
  type CompleteObservationReport,
  type CompleteObservationReportPage,
  type ObservationSpanDetail,
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
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' }
const reportId = (report: CompleteObservationReport) =>
  report.state === 'ready' ? report.header.reportId : report.reportId

describeEachProvider('RFC-371 complete execution facts without numeric subtotals', (harness) => {
  test('202 original Tasks and every invocation survive incomplete usage; all child numbers are redacted and damaged facts are rejected', async () => {
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
      expect(report.facts.summary.metrics.state).toBe('not-ready')
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
          expect(row.metrics).toEqual(report.facts.summary.metrics)
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
        const page = await service.page<{ metrics: unknown }>(actor, id, { section, limit: 100 })
        expect(page.items.length).toBeGreaterThan(0)
        for (const row of page.items) expect(row.metrics).toEqual(report.facts.summary.metrics)
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
      await expect(
        cache.page((await cache.get(id))!, {
          section: 'allocations',
          parent: null,
          after: null,
          limit: 100,
        }),
      ).rejects.toThrow('numeric evidence is incomplete')
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
