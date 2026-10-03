import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  type ObservationDimensionSelection,
  type CompleteObservationInvocation,
  type CompleteObservationTraceStatus,
  type ObservationSpanDetail,
  type ObservationSpanFact,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { observationInvocations, taskExecutionObservationSources } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { buildCompleteObservationTask } from '@/modules/run-observability/application/completeObservationTask'
import { buildCompleteObservationCohort } from '@/modules/run-observability/application/completeObservationCohort'
import { selectCompleteObservationTask } from '@/modules/run-observability/application/completeObservationSelection'
import type { CompleteObservationReportRow } from '@/modules/run-observability/ports/completeObservationReport'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
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
const TASK = 'complete-original-task'
const fact = (run: number, n: number): ObservationSpanFact => ({
  schemaVersion: 1,
  invocationId: completeFixtureId('invocation', run),
  spanKey: completeFixtureId('span', n),
  scope: {
    sourceNamespace: 'original-span-source',
    rootSessionId: completeFixtureId('root', run),
    nativeSessionId: completeFixtureId('root', run),
    parentNativeSessionId: null,
    ancestors: [],
    callId: completeFixtureId('call', n),
    kind: 'model',
  },
  label: 'Actual model step',
  parentCallId: null,
  model: { provider: 'native', id: 'actual' },
  measurementRecordId: n < 10001 ? completeFixtureId('meter', n) : null,
  state: {
    startedAt: COMPLETE_NOW + n,
    endedAt: COMPLETE_NOW + n + 1,
    nativeObservedAt: COMPLETE_NOW + n + 1,
    status: 'success',
  },
  capturedAt: COMPLETE_NOW + n + 1,
})

async function seedSpans(harness: ProviderHarness, attempts: number, perAttempt: number) {
  const accepted = await harness.db.select().from(observationInvocations).all()
  const sources = []
  for (let run = 0; run < attempts; run++) {
    const row = accepted.find((row) => row.id === completeFixtureId('invocation', run))!
    const document = {
      ...JSON.parse(row.document),
      spanCaptureContract: 'runtime-span-facts-v1',
      spanCaptureSource: 'original-span-source',
    }
    await harness.db
      .update(observationInvocations)
      .set({ document: JSON.stringify(document), fingerprint: JSON.stringify(document) })
      .where(eq(observationInvocations.id, row.id))
      .run()
    const facts = Array.from({ length: perAttempt + (run === attempts - 1 ? 1 : 0) }, (_, n) =>
      fact(run, run + n * attempts),
    )
    // Retained, already acknowledged span-only frames; numeric owner rows are seeded independently above.
    sources.push({
      taskId: TASK,
      nodeRunId: completeFixtureId('run', run),
      pending: false,
      evidenceJson: JSON.stringify({
        invocationId: row.id,
        diagnostics: [],
        measurements: [],
        spanFacts: facts,
        spanCapture: {
          contract: 'runtime-span-facts-v1',
          sourceNamespace: 'original-span-source',
          rootSessionId: completeFixtureId('root', run),
          epoch: 0,
          state: 'complete',
          baseline: { kind: 'fresh', fingerprint: null },
          snapshotFingerprint: 'original-full-proof',
          capturedAt: COMPLETE_NOW + attempts * (perAttempt + 1),
          scannedSessions: 1,
          scannedParts: facts.length,
          issues: [],
        },
      }),
    })
  }
  for (let start = 0; start < sources.length; start += 50)
    await harness.db
      .insert(taskExecutionObservationSources)
      .values(sources.slice(start, start + 50))
      .run()
}

async function build(
  harness: ProviderHarness,
  selection: ObservationDimensionSelection | null = null,
) {
  const binding = harness.applicationBinding
  return originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'complete-span-fixture' }
      : { provider: 'postgresql', runtime: binding.runtime },
  ).run(async ({ executor, workspace, snapshotId }) => {
    const owner = createTaskObservationFacts(executor),
      task = await owner.get(actor, TASK)
    if (!task) throw new Error('Original Task missing')
    const value = completeObservationValuation({
      db: executor,
      rows: workspace,
      namespace: 'span-value',
    })
    const input = {
      task,
      trace: true,
      sources: createCompleteObservationSources({
        db: executor,
        tasks: owner,
        snapshotId,
        pageSize: 61,
      }),
      asOf: COMPLETE_NOW + 30000,
      rows: workspace,
      namespace: 'span-task',
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: value.value,
    }
    const original = await buildCompleteObservationTask(input)
    const result = await selectCompleteObservationTask(input, original, selection)
    if (!result) throw new Error('Selected trace missing')
    await value.flush()
    if (!result.trace) throw new Error('Complete trace not built')
    const spans = [],
      statuses: CompleteObservationTraceStatus[] = [],
      invocations: CompleteObservationInvocation[] = [],
      captures: { readonly invocationId: string }[] = []
    for await (const row of completeWorkingTraversal<{
      nodeRunId: string
      detail: ObservationSpanDetail
    }>(workspace, result.trace.spansNamespace))
      spans.push(row.document)
    for await (const row of completeWorkingTraversal<CompleteObservationTraceStatus>(
      workspace,
      result.trace.statusesNamespace,
    ))
      statuses.push(row.document)
    for await (const row of completeWorkingTraversal<CompleteObservationInvocation>(
      workspace,
      result.invocationsNamespace,
    ))
      invocations.push(row.document)
    for await (const row of completeWorkingTraversal<{ readonly invocationId: string }>(
      workspace,
      result.trace.capturesNamespace,
    ))
      captures.push(row.document)
    return { ...result, spans, statuses, invocations, captures }
  })
}

async function cohort(harness: ProviderHarness) {
  const binding = harness.applicationBinding
  return originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'complete-span-cohort' }
      : { provider: 'postgresql', runtime: binding.runtime },
  ).run(async ({ executor, workspace, snapshotId }) => {
    const owner = createCompleteTaskObservationFacts(executor, TASK),
      task = await owner.get(actor, TASK)
    if (!task) throw new Error('Original Task missing')
    const valuation = completeObservationValuation({
      db: executor,
      rows: workspace,
      namespace: 'cohort-value',
    })
    const result = await buildCompleteObservationCohort({
      actor,
      task,
      query: { from: COMPLETE_NOW, to: COMPLETE_NOW + 60000, timezone: 'UTC' },
      sources: createCompleteObservationSources({
        db: executor,
        tasks: owner,
        snapshotId,
        pageSize: 1,
      }),
      rows: workspace,
      namespace: 'span-cohort',
      asOf: COMPLETE_NOW + 30000,
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: valuation.value,
    })
    await valuation.flush()
    const rows: CompleteObservationReportRow[] = []
    for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
      workspace,
      result.rowsNamespace,
    ))
      rows.push(row.document)
    return { ...result, rows }
  })
}

describeEachProvider('RFC-371 full retained execution trace', (harness) => {
  test('1001 original attempts/invocations and 20021 spans cross every old query ceiling with exact full CNY links', async () => {
    await seedCompleteTask(harness, 1001, 10001)
    await seedSpans(harness, 1001, 20)
    const result = await build(harness)
    expect(result.spans).toHaveLength(20021)
    expect(result.statuses).toHaveLength(1001)
    expect(result.invocations).toHaveLength(1001)
    expect(result.statuses.every((status) => status.state === 'complete')).toBe(true)
    const last = result.statuses.find(
      (status) => status.nodeRunId === completeFixtureId('run', 1000),
    )!
    expect(last).toMatchObject({
      state: 'complete',
      spanCount: '21',
      captureCount: '1',
      priorRepairCount: '0',
    })
    expect(result.trace?.receipt?.eof).toBe(true)
    expect(BigInt(result.trace?.receipt?.pages ?? '0')).toBeGreaterThan(100n)
    const linked = result.spans.filter((row) => row.detail.usage !== null)
    expect(linked).toHaveLength(10001)
    const bins = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
    for (const row of linked)
      for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
        bins[key] += BigInt(row.detail.usage![key]!)
    const sum = (10001n * 10002n) / 2n
    expect(bins).toEqual({
      input: sum,
      cacheRead: sum * 3n,
      cacheWrite: sum * 5n,
      output: sum * 7n,
    })
    expect(
      linked.every(
        (row) => row.detail.cost?.currency === 'CNY' && row.detail.cost.completeness === 'complete',
      ),
    ).toBe(true)
    expect(result.summary.metrics).toMatchObject({
      state: 'ready',
      records: '10001',
      cost: { amount: '2500.75005' },
    })
    expect(
      new Set(
        result.spans.map((row) =>
          JSON.stringify([row.detail.fact.invocationId, row.detail.fact.spanKey]),
        ),
      ).size,
    ).toBe(20021)
  }, 120000)
  test('one missing original capture hides all trace summary numbers and cannot become a zero', async () => {
    await seedCompleteTask(harness, 2, 5)
    await seedSpans(harness, 2, 2)
    const rows = await harness.db.select().from(taskExecutionObservationSources).all(),
      row = rows.find((row) => row.nodeRunId === completeFixtureId('run', 1))!
    const frame = JSON.parse(row.evidenceJson!)
    delete frame.spanCapture
    await harness.db
      .update(taskExecutionObservationSources)
      .set({ evidenceJson: JSON.stringify(frame) })
      .where(eq(taskExecutionObservationSources.id, row.id))
      .run()
    const result = await build(harness),
      status = result.statuses.find((status) => status.nodeRunId === row.nodeRunId)
    expect(result.spans).toHaveLength(5)
    expect(status).toEqual({
      taskId: TASK,
      nodeRunId: row.nodeRunId,
      state: 'not-ready',
      reasons: ['span-capture-pending'],
      knownRange: { from: COMPLETE_NOW + 1, to: COMPLETE_NOW + 6 },
    })
    expect(status).not.toHaveProperty('spanCount')
    expect(status).not.toHaveProperty('captureCount')
    expect(
      result.statuses.find((status) => status.nodeRunId === completeFixtureId('run', 0))?.state,
    ).toBe('complete')
  })
  test('a selected Task keeps its full trace and only the selected original captures and numeric links', async () => {
    await seedCompleteTask(harness, 2, 5)
    await seedSpans(harness, 2, 2)
    const other = await harness.db
      .select()
      .from(observationInvocations)
      .where(eq(observationInvocations.id, completeFixtureId('invocation', 1)))
      .get()
    if (!other) throw new Error('Original invocation missing')
    const document = { ...JSON.parse(other.document), purpose: 'system' }
    await harness.db
      .update(observationInvocations)
      .set({ document: JSON.stringify(document), fingerprint: JSON.stringify(document) })
      .where(eq(observationInvocations.id, other.id))
      .run()
    const result = await build(harness, { purpose: 'task' })
    expect(result.spans).toHaveLength(2)
    expect(result.statuses).toHaveLength(1)
    expect(result.invocations).toHaveLength(1)
    expect(result.captures).toHaveLength(1)
    expect(result.trace?.receipt?.eof).toBe(true)
    expect(
      result.spans.every(
        (row) => row.detail.fact.invocationId === completeFixtureId('invocation', 0),
      ),
    ).toBe(true)
    expect(result.captures[0]?.invocationId).toBe(completeFixtureId('invocation', 0))
    expect(result.statuses[0]).toMatchObject({
      state: 'complete',
      spanCount: '2',
      captureCount: '1',
    })
    expect(result.summary.metrics).toMatchObject({
      state: 'ready',
      records: '3',
      tokens: { input: '9', cacheRead: '27', cacheWrite: '45', output: '63' },
    })
    expect(result.spans.map((row) => row.detail.usage?.input).sort()).toEqual(['1', '3'])
  })
  test('complete cohort retains each span and invocation under its exact attempt and invocation parent', async () => {
    await seedCompleteTask(harness, 2, 5)
    await seedSpans(harness, 2, 2)
    const result = await cohort(harness)
    expect(result.summary.metrics).toMatchObject({ state: 'ready', records: '5' })
    expect(
      result.rows.filter((row) => row.section === 'span-facts' && row.parent === null),
    ).toHaveLength(5)
    for (let n = 0; n < 2; n++) {
      const parent = JSON.stringify([
        'invocation',
        completeFixtureId('run', n),
        completeFixtureId('invocation', n),
      ])
      const rows = result.rows.filter(
        (row) => row.section === 'span-facts' && row.parent === parent,
      )
      expect(rows).toHaveLength(n === 0 ? 2 : 3)
      expect(
        rows.every(
          (row) =>
            (row.document as ObservationSpanDetail).fact.invocationId ===
            completeFixtureId('invocation', n),
        ),
      ).toBe(true)
      const calls = result.rows.filter(
        (row) => row.section === 'invocations' && row.parent === parent,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.document).toMatchObject({
        invocationId: completeFixtureId('invocation', n),
        nodeRunId: completeFixtureId('run', n),
      })
    }
  })
})
