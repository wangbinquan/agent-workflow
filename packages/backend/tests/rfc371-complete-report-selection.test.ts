// RFC-371: old dimension links select the complete original population, never a display page.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  nodeRuns,
  observationInvocations,
  observationUsageCaptures,
  observationUsageCurrent,
  taskExecutionObservationSources,
  tasks,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { buildCompleteObservationCohort } from '@/modules/run-observability/application/completeObservationCohort'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import type { CompleteObservationReportRow } from '@/modules/run-observability/ports/completeObservationReport'
import {
  AcceptedObservationInvocationSchema,
  type ObservationDimensionSelection,
} from '@agent-workflow/shared'
import type { ProviderHarness } from './helpers/eachProvider'
import { describeEachProvider } from './helpers/eachProvider'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'

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
const agent: ObservationDimensionSelection = {
  agent: { id: 'original-agent', revision: 1 },
  purpose: 'task',
}
const model: ObservationDimensionSelection = {
  model: { authority: 'local', sourceId: null, provider: 'native', model: 'actual' },
}
async function build(
  harness: ProviderHarness,
  selection: ObservationDimensionSelection,
  rootId?: string,
) {
  const binding = harness.applicationBinding
  const source =
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'complete-selected-original' }
      : { provider: 'postgresql' as const, runtime: binding.runtime }
  return originalReportSnapshotSession(source).run(async ({ executor, workspace, snapshotId }) => {
    const owner = createCompleteTaskObservationFacts(executor, rootId),
      root = rootId ? await owner.get(actor, rootId) : undefined
    const value = completeObservationValuation({
      db: executor,
      rows: workspace,
      namespace: 'selected-value',
    })
    const result = await buildCompleteObservationCohort({
      actor,
      query: {
        from: COMPLETE_NOW,
        to: COMPLETE_NOW + 60000,
        timezone: 'UTC',
        selection: JSON.stringify(selection),
      },
      ...(root ? { task: root } : {}),
      sources: createCompleteObservationSources({
        db: executor,
        tasks: owner,
        snapshotId,
        pageSize: 61,
      }),
      asOf: COMPLETE_NOW + 60000,
      rows: workspace,
      namespace: 'selected-cohort',
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: value.value,
    })
    await value.flush()
    const rows: CompleteObservationReportRow[] = []
    for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
      workspace,
      result.rowsNamespace,
    ))
      if (row.document.parent === null) rows.push(row.document)
    return { ...result, rows }
  })
}

async function cloneTasks(harness: ProviderHarness, count: number, outsideAgent = false) {
  const db = harness.db,
    task = await db.select().from(tasks).where(eq(tasks.id, 'complete-original-task')).get(),
    run = await db.select().from(nodeRuns).get(),
    invocation = await db.select().from(observationInvocations).get(),
    capture = await db.select().from(observationUsageCaptures).get(),
    usage = await db.select().from(observationUsageCurrent)
  if (!task || !run || !invocation || !capture) throw new Error('Original clone source missing')
  for (let from = 0; from < count; from += 50) {
    const numbers = Array.from(
        { length: Math.min(50, count - from) },
        (_, offset) => from + offset,
      ),
      id = (n: number) => 'selected-task-' + n,
      call = (n: number) => id(n) + '-call',
      runId = (n: number) => id(n) + '-run'
    await db
      .insert(tasks)
      .values(
        numbers.map((n) => ({
          ...task,
          id: id(n),
          name: 'Selected Task ' + n,
          rootTaskId: id(n),
          parentTaskId: !outsideAgent && n === 0 ? task.id : null,
          startedAt: !outsideAgent && n === 0 ? COMPLETE_NOW - 1000 : COMPLETE_NOW,
          deletedAt: n === 1 ? COMPLETE_NOW : null,
          spaceKind: n === 2 ? ('internal' as const) : task.spaceKind,
        })),
      )
      .run()
    await db
      .insert(nodeRuns)
      .values(numbers.map((n) => ({ ...run, id: runId(n), taskId: id(n) })))
      .run()
    await db
      .insert(observationInvocations)
      .values(
        numbers.map((n) => {
          const document = AcceptedObservationInvocationSchema.parse({
            ...JSON.parse(invocation.document),
            invocationId: call(n),
            taskId: id(n),
            nodeRunId: runId(n),
            agentId: outsideAgent ? 'outside-agent' : 'original-agent',
          })
          return {
            ...invocation,
            id: call(n),
            taskId: id(n),
            canonicalExecution: sha256Hex(JSON.stringify(['local', call(n)])),
            fingerprint: JSON.stringify(document),
            document: JSON.stringify(document),
          }
        }),
      )
      .run()
    await db
      .insert(observationUsageCaptures)
      .values(
        numbers.map((n) => {
          const document = JSON.parse(capture.document)
          document.evidence.invocationId = call(n)
          document.evidence.taskId = id(n)
          document.evidence.capture.rootSessionId = id(n) + '-root'
          return {
            ...capture,
            invocationId: call(n),
            taskId: id(n),
            sourceCursor: id(n) + '-cursor',
            document: JSON.stringify(document),
            summary: JSON.stringify(document),
          }
        }),
      )
      .run()
    await db
      .insert(observationUsageCurrent)
      .values(
        numbers.flatMap((n) =>
          usage.map((original) => {
            const document = JSON.parse(original.document)
            document.measurement = {
              ...document.measurement,
              taskId: id(n),
              invocationId: call(n),
              nodeRunId: runId(n),
              agentId: outsideAgent ? 'outside-agent' : 'original-agent',
            }
            return {
              ...original,
              id: sha256Hex(
                JSON.stringify([document.sourceId, call(n), document.measurement.recordId]),
              ),
              taskId: id(n),
              document: JSON.stringify(document),
            }
          }),
        ),
      )
      .run()
  }
}
describeEachProvider('RFC-371 complete dimension selection on original source', (harness) => {
  test('202 matching Tasks retain deleted/internal and out-of-window descendants without a population limit', async () => {
    await seedCompleteTask(harness, 1, 2)
    await cloneTasks(harness, 201)
    expect(
      await harness.db
        .select({ spaceKind: tasks.spaceKind })
        .from(tasks)
        .where(eq(tasks.id, 'selected-task-2'))
        .get(),
    ).toEqual({ spaceKind: 'internal' })
    const report = await build(harness, agent)
    expect(report.taskSource.rows).toBe('202')
    expect(report.summary.inventory.tasks).toBe('202')
    expect(report.summary.metrics).toMatchObject({
      state: 'ready',
      invocations: '202',
      records: '404',
      tokens: {
        input: '606',
        cacheRead: '1818',
        cacheWrite: '3030',
        output: '4242',
        total: '9696',
      },
      cost: { currency: 'CNY', state: 'complete', amount: '0.0303' },
    })
    const selected = report.rows.filter((row) => row.section === 'tasks')
    expect(new Set(selected.map((row) => row.key)).size).toBe(202)
    expect(selected.some((row) => row.key === 'selected-task-0')).toBe(true)
    expect(selected.some((row) => row.key === 'selected-task-1')).toBe(true)
    expect(selected.some((row) => row.key === 'selected-task-2')).toBe(true)
  }, 120000)
  test('Agent/runtime/purpose/actual-model intersections retain all 1001 calls and 10001 original records with frozen CNY', async () => {
    await seedCompleteTask(harness, 1001, 10001)
    const report = await build(harness, {
      ...agent,
      ...model,
      runtime: {
        authority: 'local',
        sourceId: null,
        registrationId: 'complete-runtime',
        configurationRevision: 0,
        protocol: 'opencode',
      },
    })
    expect(report.summary.metrics).toEqual({
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
    expect(report.summary.inventory).toEqual({
      tasks: '1',
      attempts: '1001',
      invocations: '1001',
      numericRecords: '10001',
      nativeCaptures: '1001',
    })
    expect(report.rows.filter((row) => row.section === 'invocations')).toHaveLength(1001)
    expect(report.rows.filter((row) => row.section === 'allocations')).toHaveLength(10001)
  }, 120000)
  for (const scenario of ['overlap', 'covered', 'unknown-model'] as const)
    test('original allocation and quality EOF retain raw population for ' + scenario, async () => {
      await seedCompleteTask(harness, 1, 2)
      const originals = await harness.db.select().from(observationUsageCurrent)
      expect(originals).toHaveLength(2)
      for (const original of originals) {
        const document = JSON.parse(original.document)
        const second = document.measurement.recordId === completeFixtureId('meter', 1)
        document.measurement.scope = {
          root: 'original-summary-root',
          session: 'original-summary-root',
          parentSession: null,
          ancestors: [],
          turn: second ? 'second-summary' : 'first-summary',
          turnIndex: second && scenario !== 'covered' ? 2 : 1,
          level: second && scenario === 'covered' ? 'request' : 'self-total',
        }
        document.measurement.coveredThroughTurn = second && scenario !== 'covered' ? 3 : 2
        if (second && scenario === 'unknown-model') document.measurement.model = null
        await harness.db
          .update(observationUsageCurrent)
          .set({ document: JSON.stringify(document) })
          .where(eq(observationUsageCurrent.id, original.id))
          .run()
      }
      for (const selection of [agent, model]) {
        const report = await build(harness, selection)
        expect(report.taskSource.rows).toBe('1')
        expect(report.summary.inventory.numericRecords).toBe('2')
        const metrics = report.summary.metrics
        if (scenario === 'covered') {
          expect(metrics).toEqual({
            state: 'ready',
            invocations: '1',
            observedInvocations: '1',
            records: '1',
            tokens: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7', total: '16' },
            cost: { currency: 'CNY', state: 'complete', amount: '0.00005' },
          })
        } else {
          if (metrics.state !== 'not-ready') throw new Error('Original excluded ambiguity lost')
          expect(metrics.gaps).toContain('coverage-incomplete')
          if (scenario === 'unknown-model' && selection === model)
            expect(metrics.gaps).toContain('dimension-unresolved')
          expect(metrics.tokenCoverage).toEqual({
            invocations: '1',
            observedInvocations: '1',
            records: '2',
            bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
          })
          expect(metrics.recordedUsage?.tokens).toEqual({
            input: '1',
            cacheRead: '3',
            cacheWrite: '5',
            output: '7',
            total: '16',
          })
          expect(metrics.recordedCost).toEqual({
            currency: 'CNY',
            amount: '0.00005',
            records: '2',
            pricedRecords: '1',
          })
          expect(metrics).not.toHaveProperty('tokens')
          expect(metrics).not.toHaveProperty('cost')
          if (scenario === 'overlap') {
            const dimensions = report.rows.filter((row) => row.section === 'models')
            expect(dimensions).toHaveLength(1)
            expect((dimensions[0]!.document as { metrics: unknown }).metrics).toEqual(metrics)
            const contributions = report.rows.filter((row) => row.section === 'tasks')
            expect(contributions).toHaveLength(1)
            expect((contributions[0]!.document as { metrics: unknown }).metrics).toEqual(metrics)
          }
        }
        expect(report.rows.filter((row) => row.section === 'allocations')).toHaveLength(1)
      }
    })
  test('a complete excluded model has no matching population and does not become a numeric zero', async () => {
    await seedCompleteTask(harness, 1, 2)
    const report = await build(harness, {
      model: { authority: 'local', sourceId: null, provider: 'native', model: 'other' },
    })
    expect(report.summary.inventory.tasks).toBe('0')
    expect(report.summary.metrics).toEqual({ state: 'not-applicable' })
    expect(report.rows.filter((row) => row.section === 'tasks')).toEqual([])
    expect(report.taskSource.rows).toBe('1')
  })
  test('a model-specific zero is not inferred from an invocation-wide empty capture', async () => {
    await seedCompleteTask(harness, 1, 0)
    const report = await build(harness, model)
    expect(report.summary.metrics).toEqual({
      state: 'not-ready',
      gaps: ['dimension-unresolved'],
      tokenCoverage: {
        invocations: '1',
        observedInvocations: '0',
        records: '0',
        bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
      },
    })
    expect(report.summary.metrics).not.toHaveProperty('tokens')
    expect(report.summary.metrics).not.toHaveProperty('cost')
  })
  test('missing frozen runtime attribution stays unresolved and has no numeric subtotal', async () => {
    await seedCompleteTask(harness, 1, 2)
    const old = await harness.db.select().from(observationInvocations).get()
    if (!old) throw new Error('Original invocation missing')
    const document = AcceptedObservationInvocationSchema.parse({
      ...JSON.parse(old.document),
      authority: { kind: 'local', runtime: null },
      priceBookRevision: null,
    })
    await harness.db
      .update(observationInvocations)
      .set({ document: JSON.stringify(document), fingerprint: JSON.stringify(document) })
      .where(eq(observationInvocations.id, old.id))
      .run()
    const report = await build(harness, {
      runtime: {
        authority: 'local',
        sourceId: null,
        registrationId: 'complete-runtime',
        configurationRevision: 0,
        protocol: 'opencode',
      },
    })
    expect(report.summary.metrics.state).toBe('not-ready')
    if (report.summary.metrics.state !== 'not-ready')
      throw new Error('Unresolved attribution published')
    expect(report.summary.metrics.gaps).toContain('dimension-unresolved')
    expect(report.summary.metrics).not.toHaveProperty('tokens')
  })
  test('unprojected original source cannot be hidden by excluding its known Agent', async () => {
    await seedCompleteTask(harness, 1, 2)
    await harness.db
      .insert(taskExecutionObservationSources)
      .values({
        taskId: 'complete-original-task',
        nodeRunId: completeFixtureId('run', 0),
        evidenceJson: JSON.stringify({
          invocationId: completeFixtureId('invocation', 0),
          measurements: [],
          diagnostics: [],
        }),
        pending: true,
      })
      .run()
    const report = await build(harness, { agent: { id: 'different-agent', revision: 1 } })
    expect(report.summary.metrics).toEqual({
      state: 'not-ready',
      gaps: ['source-projection-pending'],
      tokenCoverage: {
        invocations: '0',
        observedInvocations: '0',
        records: '0',
        bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
      },
    })
    expect(report.summary.metrics).not.toHaveProperty('tokens')
    expect(report.summary.metrics).not.toHaveProperty('cost')
  })
  test('an excluded root anchor still accounts for its matching out-of-window child', async () => {
    await seedCompleteTask(harness, 1, 2)
    await cloneTasks(harness, 1, true)
    await harness.db
      .update(tasks)
      .set({
        parentTaskId: 'selected-task-0',
        rootTaskId: 'selected-task-0',
        startedAt: COMPLETE_NOW - 1000,
      })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    const report = await build(harness, agent, 'selected-task-0')
    expect(report.taskSource.rows).toBe('2')
    expect(report.summary.inventory.tasks).toBe('1')
    expect(report.summary.rootTask?.task.id).toBe('selected-task-0')
    expect(report.summary.rootTask?.metrics).toMatchObject({
      state: 'ready',
      tokens: { total: '48' },
      cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
    })
    expect(report.rows.filter((row) => row.section === 'tasks').map((row) => row.key)).toEqual([
      'complete-original-task',
    ])
  })
})
