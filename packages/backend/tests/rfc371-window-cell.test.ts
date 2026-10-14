import { qualifiedObservationIndexes } from '@/modules/run-observability/domain/qualifiedObservationIndexes'
// RFC-371: numerical cells are reversible acceleration, never synthetic original records.
import { expect, test } from 'bun:test'
import {
  observationWindowCellKey,
  originalObservationTimePartition,
  decodeObservationWindowCell,
  completeWindowCell,
} from '@/modules/run-observability/domain/observationWindowCell'
import {
  observationRowCountKey,
  observationRowCountFold,
} from '@/modules/run-observability/domain/observationRowCount'
import {
  emptyCompleteObservationFold,
  completeObservationMetrics,
  addCompleteObservationAllocation,
  completeObservationGap,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import {
  emptyIncrementalObservationFold,
  replaceIncrementalObservationContribution,
  completeIncrementalObservationFold,
} from '@/modules/run-observability/domain/incrementalObservationFold'
import { incrementalObservationWindow } from '@/modules/run-observability/application/incrementalObservationWindow'
import type {
  CompleteObservationTimePartition,
  CompleteObservationTask,
  CompleteObservationInvocation,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
const at = Date.parse('2026-10-13T00:10:00Z'),
  task: ObservationTaskFacts = {
    id: 'original',
    name: 'Original',
    status: 'done',
    parentTaskId: null,
    startedAt: at,
    finishedAt: at + 100,
    runningSince: null,
    runningMs: 100,
  }
function row(
  recordId: string,
  count: string,
): CompleteObservationTimePartition & { referenceIds: string[]; model: null } {
  const fold = emptyCompleteObservationFold()
  addCompleteObservationAllocation(
    fold,
    { input: count, cacheRead: '3', cacheWrite: '0', output: '7' },
    { amount: '0.000000000001', complete: true, hidden: false },
  )
  return {
    identity: recordId,
    recordId,
    sourceId: 'original',
    kind: 'historical',
    task,
    invocation: null,
    occurrence: { occurredAt: at, basis: 'native-step' },
    partition: 'in-window',
    metrics: completeObservationMetrics(fold),
    referenceIds: [],
    model: null,
  }
}
test('record IDs and changed four buckets do not split a stable cell; model/owner/hour changes do', () => {
  const a = row('a', '9007199254740993'),
    b = row('b', '17'),
    key = observationWindowCellKey('original-owner', a)!
  expect(observationWindowCellKey('original-owner', b)).toBe(key)
  expect(observationWindowCellKey('other-owner', a)).not.toBe(key)
  expect(decodeObservationWindowCell(key).original).not.toHaveProperty('recordId')
  expect(
    observationWindowCellKey('original-owner', {
      ...a,
      occurrence: { occurredAt: null, basis: null },
    }),
  ).toBeNull()
})
test('exact inverse revisions preserve old sums and do not let a larger replacement hide missing old membership', () => {
  const old = {
      ...emptyCompleteObservationFold(),
      tokens: { input: '9007199254740993', cacheRead: '11', cacheWrite: '0', output: '7' },
    },
    next = { ...old, tokens: { ...old.tokens, input: '9007199254740999' } }
  let total = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    old,
  )
  const snapshot = total
  total = replaceIncrementalObservationContribution(total, old, next)
  expect(total.tokens.input).toBe('9007199254740999')
  expect(snapshot.tokens.input).toBe('9007199254740993')
  expect(() =>
    replaceIncrementalObservationContribution(emptyIncrementalObservationFold(), old, next),
  ).toThrow('underflow')
  expect(replaceIncrementalObservationContribution(total, next, null).tokens.input).toBe('0')
})
test('a private aggregate cell contributes exact values and DISTINCT membership, but never appears in original time rows', () => {
  const original = row('a', '9007199254740993'),
    key = observationWindowCellKey('owner', original)!,
    fold = {
      ...emptyCompleteObservationFold(),
      tokens: { input: '9007199254740993', cacheRead: '3', cacheWrite: '0', output: '7' },
      records: '1',
      bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
    },
    cell = completeWindowCell(decodeObservationWindowCell(key), fold),
    window = incrementalObservationWindow({
      query: { from: at - 600000, to: at + 3600000, timezone: 'UTC', cohort: 'usage' },
      tasks: [
        {
          task,
          metrics: completeObservationMetrics(fold),
          attemptCount: '0',
          timing: {
            wallMs: '100',
            runningMs: '100',
            range: null,
            intervals: { state: 'complete', unknown: '0', cumulativeMs: '0', activeUnionMs: '0' },
          },
        },
      ],
      occurrences: [
        {
          key,
          component: 'owner',
          aggregates: [],
          fold,
          detail: {
            section: 'time-partitions',
            parent: null,
            key,
            taskId: task.id,
            cohortAt: cell.occurrence.occurredAt,
            document: cell,
          },
        },
      ],
      invocations: [],
      historical: [],
    })
  expect(window.timeRows).toEqual([])
  expect(window.fold.tokens.input).toBe('9007199254740993')
  expect(window.trends).toHaveLength(1)
})
test('page-count weights are independent from numerical quantities and move reversibly with their original scope', () => {
  const scope = {
      section: 'allocations' as const,
      parent: null,
      key: 'a',
      taskId: task.id,
      cohortAt: at,
    },
    a = observationRowCountKey('owner', scope)
  expect(observationRowCountKey('owner', { ...scope, key: 'b' })).toBe(a)
  const first = replaceIncrementalObservationContribution(
      emptyIncrementalObservationFold(),
      null,
      observationRowCountFold(),
    ),
    second = replaceIncrementalObservationContribution(first, null, observationRowCountFold())
  expect(second.counters.numericRecords).toBe('2')
  expect(completeIncrementalObservationFold(second).tokens.input).toBe('0')
})

test('a cohort counts all 211 original Tasks and missing-usage days without manufacturing Token or CNY values', () => {
  const numeric = row('one-original-record', '9007199254740993'),
    fold = emptyCompleteObservationFold(),
    missing = emptyCompleteObservationFold()
  addCompleteObservationAllocation(
    fold,
    { input: '9007199254740993', cacheRead: '3', cacheWrite: '0', output: '7' },
    { amount: '0.000000000001', complete: true, hidden: false },
  )
  completeObservationGap(missing, 'original-invocation-unobserved')
  const timing: CompleteObservationTask['timing'] = {
      wallMs: '100',
      runningMs: '100',
      range: null,
      intervals: { state: 'complete', unknown: '0', cumulativeMs: '0', activeUnionMs: '0' },
    },
    tasks: CompleteObservationTask[] = [
      { task, metrics: numeric.metrics, attemptCount: '0', timing },
      ...Array.from({ length: 210 }, (_, index) => ({
        task: {
          ...task,
          id: 'no-numeric-record-' + index,
          status: 'failed' as const,
          startedAt: at + (index < 110 ? 0 : 86400000),
        },
        metrics: completeObservationMetrics(
          index === 209 ? missing : emptyCompleteObservationFold(),
        ),
        attemptCount: '0',
        timing,
      })),
    ],
    input = {
      query: { from: at - 1, to: at + 2 * 86400000, timezone: 'UTC' },
      tasks,
      occurrences: [
        {
          key: 'original-occurrence',
          component: 'original-owner',
          aggregates: [],
          fold,
          detail: {
            section: 'time-partitions' as const,
            parent: null,
            key: 'original-occurrence',
            taskId: task.id,
            cohortAt: at,
            document: numeric,
          },
        },
      ],
      invocations: [],
      historical: [],
    },
    cohort = incrementalObservationWindow({ ...input, mode: 'cohort' })
  expect(cohort.tasks).toHaveLength(211)
  expect(cohort.trends.map((day) => day.tasks)).toEqual(['111', '100'])
  expect(cohort.trends[1]!.metrics.state).toBe('not-ready')
  expect(cohort.fold.tokens).toEqual(fold.tokens)
  expect(cohort.fold.records).toBe('1')
  expect(cohort.fold.picos).toBe('1')
  const usage = incrementalObservationWindow({
      ...input,
      query: { ...input.query, cohort: 'usage' },
      mode: 'usage',
    }),
    selected = incrementalObservationWindow({
      ...input,
      query: { ...input.query, selection: 'original-selected-dimension' },
      mode: 'cohort',
    })
  expect(usage.trends.map((day) => day.tasks)).toEqual(['1'])
  expect(selected.trends.map((day) => day.tasks)).toEqual(['1'])
  expect(selected.tasks).toHaveLength(1)
  expect(usage.fold.tokens).toEqual(fold.tokens)
  expect(selected.fold.tokens).toEqual(fold.tokens)
})

for (const partial of [false, true])
  test(`a ${partial ? 'gapped' : 'ready'} proven zero-use call belongs to the full Task cohort without manufacturing a usage record`, () => {
    const fold = emptyCompleteObservationFold()
    fold.invocations = '1'
    fold.observedInvocations = '1'
    fold.knownZeroInvocations = '1'
    fold.knownZeroCostInvocations = '1'
    if (partial) completeObservationGap(fold, 'original-invocation-unobserved')
    const metrics = completeObservationMetrics(fold),
      invocation: CompleteObservationInvocation = {
        invocationId: 'original-proven-zero-call',
        taskId: task.id,
        taskName: task.name,
        agentName: 'Original Agent',
        nodeRunId: 'original-zero-run',
        agentId: 'original-agent',
        agentRevision: 1,
        purpose: 'task',
        nativeCaptureContract: 'opencode-child-steps-v1',
        nativeCaptureSource: 'original-zero-proof',
        authority: {
          kind: 'local',
          runtime: {
            registrationId: 'original-runtime',
            acceptedName: 'Original',
            configurationRevision: 0,
            protocol: 'opencode',
          },
        },
        acceptedAt: at,
        priceBookRevision: 1,
        metrics,
      },
      result = incrementalObservationWindow({
        query: { from: at - 1, to: at + 1000, timezone: 'UTC' },
        mode: 'cohort',
        tasks: [
          {
            task,
            metrics,
            attemptCount: '1',
            timing: {
              wallMs: '100',
              runningMs: '100',
              range: null,
              intervals: { state: 'complete', unknown: '0', cumulativeMs: '0', activeUnionMs: '0' },
            },
          },
        ],
        occurrences: [],
        invocations: [invocation],
        historical: [],
      })
    expect(result.invocations).toHaveLength(1)
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]!.metrics).toEqual(metrics)
    expect(result.trends[0]!.metrics).toEqual(metrics)
    expect(result.fold.records).toBe('0')
    expect(result.fold.invocations).toBe('1')
    expect(result.fold.knownZeroInvocations).toBe('1')
    expect(result.fold.knownZeroCostInvocations).toBe('1')
    expect(result.fold.tokens).toEqual({ input: '0', cacheRead: '0', cacheWrite: '0', output: '0' })
  })

test('compact descriptor replay is idempotent and scope metadata is kept outside index keys', () => {
  const document = row('a', '17'),
    fold = emptyCompleteObservationFold(),
    original = {
      key: 'original',
      component: 'owner',
      fold,
      aggregates: [],
      detail: {
        section: 'time-partitions' as const,
        parent: null,
        key: 'original',
        taskId: task.id,
        cohortAt: at,
        document,
      },
    },
    indexed = qualifiedObservationIndexes(original)
  expect(indexed.aggregates.every((key) => key.length < 100)).toBe(true)
  expect(qualifiedObservationIndexes(indexed)).toEqual(indexed)
  expect(Object.values(indexed.descriptors!)).toContain(
    observationWindowCellKey('owner', document)!,
  )
})

// CI 38452454414 exposed doubled four-bucket/CNY usage: qualification and replay
// inserted equivalent cell descriptors in a different JSON property order.
test('a retained atom replaces all derived index aliases rather than applying its values twice', () => {
  const document = row('original-record', '9007199254740993'),
    raw = {
      key: 'original-atom',
      component: 'owner',
      fold: emptyCompleteObservationFold(),
      aggregates: ['task/' + task.id, 'original-day'],
      detail: {
        section: 'time-partitions' as const,
        parent: null,
        key: 'original-atom',
        taskId: task.id,
        cohortAt: at,
        document,
      },
    },
    first = qualifiedObservationIndexes(raw),
    reordered = Object.fromEntries(Object.entries(document).reverse()) as typeof document,
    legacy = observationWindowCellKey(raw.component, reordered)!
  expect(legacy).not.toBe(observationWindowCellKey(raw.component, document))
  const polluted = {
      ...first,
      aggregates: [
        ...first.aggregates,
        legacy,
        observationRowCountKey('previous-owner', {
          ...raw.detail,
          document: { ...document, invocationId: undefined },
        }),
      ],
    },
    repaired = qualifiedObservationIndexes(polluted)
  expect(repaired).toEqual(first)
  expect(repaired.aggregates.filter((key) => key.startsWith('occurrence-cell/'))).toHaveLength(1)
  expect(repaired.aggregates.filter((key) => key.startsWith('row-count/'))).toHaveLength(1)
  expect(repaired.aggregates).toContain('task/' + task.id)
  expect(repaired.aggregates).toContain('original-day')
  expect(qualifiedObservationIndexes(repaired)).toEqual(repaired)
  expect(repaired.fold).toBe(raw.fold)
  expect(repaired.detail.document).toBe(document)
})

test('public time rows retain all original fields and partitions without private index metadata', () => {
  const original = row('actual-original', '17'),
    privateRow = {
      ...original,
      candidateCount: '1',
      visibility: [],
      dimensions: [],
      unknownDimensions: [],
      nativeRecord: true,
      scopes: [],
      projectionCell: { from: at, to: at + 3600000 },
    },
    { referenceIds: _references, model: _model, ...publicOriginal } = original
  const publicRow = originalObservationTimePartition(privateRow, 'outside-window')
  expect(publicRow).toEqual({ ...publicOriginal, partition: 'outside-window' })
  expect(Object.keys(publicRow).sort()).toEqual(
    [
      'identity',
      'kind',
      'recordId',
      'sourceId',
      'task',
      'invocation',
      'occurrence',
      'metrics',
      'partition',
    ].sort(),
  )
  expect(publicRow.metrics).toBe(original.metrics)
  expect(publicRow.occurrence).toBe(original.occurrence)
})
