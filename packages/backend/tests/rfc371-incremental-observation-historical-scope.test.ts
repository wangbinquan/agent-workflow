// RFC-371: historical membership keeps original owner clocks, root ambiguity,
// filtering and DST semantics without repeating native reads or allocation.
import { expect, test } from 'bun:test'
import type {
  CompleteObservationTask,
  CompleteHistoricalObservationExecution,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import { incrementalObservationHistoricalScope } from '@/modules/run-observability/application/incrementalObservationHistoricalScope'
import {
  emptyCompleteObservationFold,
  addCompleteObservationAllocation,
  completeObservationMetrics,
  mergeCompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'
import { incrementalObservationSelection } from '@/modules/run-observability/application/incrementalObservationSelection'
import type { HistoricalRecordScopeGroup } from '@/modules/run-observability/ports/incrementalObservationQualified'
import { incrementalObservationWindow } from '@/modules/run-observability/application/incrementalObservationWindow'
import { incrementalObservationWindowRows } from '@/modules/run-observability/application/incrementalObservationWindowRows'

const at = Date.parse('2026-10-12T00:00:00Z')
const owner = (
  id: string,
  patch: Partial<HistoricalObservationExecution> = {},
): HistoricalObservationExecution => ({
  kind: 'historical-observed',
  referenceId: id,
  sourceKind: 'memory-distill',
  ownerId: id,
  attemptId: null,
  nodeRunId: null,
  parentTaskId: 'parent',
  ownerUserId: 'reader',
  name: 'Memory extraction',
  status: 'done',
  createdAt: at,
  startedAt: at,
  finishedAt: at + 1,
  agentId: null,
  agentRevision: null,
  agentName: null,
  purpose: 'memory',
  runtime: null,
  rootSessionId: 'root',
  recordedUsage: null,
  ...patch,
})

test('each original record reference retains its own match while compact physical evidence is shared and memoized', () => {
  const a = owner('a', { parentTaskId: null, agentId: 'a', agentRevision: 1 }),
    b = owner('b', { parentTaskId: null, agentId: 'b', agentRevision: 1 }),
    f = fixture([a, b]),
    query = { ...f.query, selection: JSON.stringify({ agent: { id: 'a', revision: 1 } }) },
    scopeGroups = new Map<string, HistoricalRecordScopeGroup>([
      [
        'shared',
        { scopes: [a, b], model: null, observed: true, numeric: emptyCompleteObservationFold() },
      ],
    ]),
    scopeMatches: NonNullable<
      Parameters<typeof incrementalObservationHistoricalScope>[1]['scopeMatches']
    > = new Map(),
    { scopes: _scopes, ...compact } = f.row.detail
  for (const [execution, match] of [
    [a, 'matched'],
    [b, 'excluded'],
  ] as const) {
    const document = {
        referenceId: execution.referenceId,
        execution,
        scopeMatch: 'matched',
        timeBasis: 'execution-start',
        cohortAt: at,
      },
      row = {
        ...f.row,
        fold: emptyCompleteObservationFold(),
        detail: {
          ...compact,
          section: 'historical-record-references' as const,
          parent: 'original-record',
          historicalRecordScopes: ['shared'],
          document,
        },
      },
      actual = incrementalObservationHistoricalScope(row, {
        ...f,
        query,
        ids: new Set(),
        scopeGroups,
        scopeMatches,
      })!
    expect(actual.detail.document).toEqual({ ...document, scopeMatch: match })
    expect(actual.detail.scopes).toBeUndefined()
  }
  const native = { ...f.row, detail: { ...compact, historicalRecordScopes: ['shared'] } }
  for (let n = 0; n < 23; n++) {
    const actual = incrementalObservationHistoricalScope(native, {
      ...f,
      query,
      ids: new Set(),
      scopeGroups,
      scopeMatches,
    })!
    expect(actual.fold.records).toBe('0')
    expect(actual.fold.gaps).toContain('historical-scope-unresolved')
  }
  expect(scopeMatches.size).toBe(1)
  expect(scopeMatches.get('shared')?.members.map((member) => member.scopeMatch)).toEqual([
    'matched',
    'excluded',
  ])
})

test('Agent selection keeps both mixed physical references and does not replace the canonical attribution gap', () => {
  const a = owner('agent-a', { parentTaskId: null, agentId: 'a', agentRevision: 1 }),
    b = owner('agent-b', { parentTaskId: null, agentId: 'b', agentRevision: 1 }),
    f = fixture([a, b]),
    selection = { agent: { id: 'a', revision: 1 } },
    query = { ...f.query, cohort: 'usage' as const, selection: JSON.stringify(selection) },
    scopeGroups = new Map<string, HistoricalRecordScopeGroup>([
      [
        'shared',
        { scopes: [a, b], observed: true, model: null, numeric: emptyCompleteObservationFold() },
      ],
    ]),
    fold = {
      ...emptyCompleteObservationFold(),
      historicalReferences: '1',
      observedHistoricalReferences: '1',
      gaps: ['historical-invocation-unobserved', 'historical-attribution-unresolved'],
    },
    historical = [a, b].map((execution) => {
      const document: CompleteHistoricalObservationExecution = {
        execution,
        referenceRole: 'execution',
        parentTaskName: null,
        scopeMatch: 'matched',
        timeBasis: 'execution-start',
        cohortAt: at,
        coveredByAcceptedRecords: false,
        metrics: completeObservationMetrics(fold),
        issues: fold.gaps,
      }
      return incrementalObservationHistoricalScope(
        {
          ...f.row,
          fold,
          detail: {
            ...f.row.detail,
            nativeRecord: false,
            section: 'historical-executions',
            document,
            scopes: [execution],
            historicalRecordScopes: ['shared'],
          },
        },
        { ...f, query, ids: new Set(), scopeGroups },
      )!.detail.document as CompleteHistoricalObservationExecution
    }),
    qualified = incrementalObservationSelection({
      selection,
      calls: [],
      atoms: [],
      historical,
      historicalScopeQualified: true,
    })
  expect(qualified.historical).toHaveLength(2)
  expect(qualified.historical.map((row) => row.scopeMatch)).toEqual(['unresolved', 'unresolved'])
  for (const row of qualified.historical) {
    expect(row.metrics).toEqual(
      completeObservationMetrics({
        ...fold,
        observedHistoricalReferences: '0',
        gaps: [...fold.gaps, 'historical-scope-unresolved'],
      }),
    )
    expect(row.issues).not.toContain('dimension-unresolved')
  }
})

test('model selection reconstructs unique-owner received buckets and CNY only from selected physical groups', () => {
  const execution = owner('unique', { parentTaskId: null }),
    f = fixture([execution]),
    a = emptyCompleteObservationFold(),
    b = emptyCompleteObservationFold()
  addCompleteObservationAllocation(
    a,
    { input: '9007199254740997', cacheRead: '19', cacheWrite: '23', output: '29' },
    { amount: '1.234567890123', complete: true, hidden: false },
  )
  addCompleteObservationAllocation(
    b,
    { input: '101', cacheRead: '103', cacheWrite: '107', output: '109' },
    { amount: '9.876543210987', complete: true, hidden: false },
  )
  const full = emptyCompleteObservationFold()
  mergeCompleteObservationFold(full, a)
  mergeCompleteObservationFold(full, b)
  Object.assign(full, {
    historicalReferences: '1',
    observedHistoricalReferences: '1',
    gaps: ['historical-invocation-unobserved'],
  })
  const source: QualifiedObservationContribution = {
      ...f.row,
      fold: {
        ...emptyCompleteObservationFold(),
        historicalReferences: '1',
        observedHistoricalReferences: '1',
      },
      detail: {
        ...f.row.detail,
        section: 'historical-executions',
        nativeRecord: false,
        historicalRecordScopes: ['a', 'b'],
        document: {
          execution,
          referenceRole: 'execution',
          parentTaskName: null,
          scopeMatch: 'matched',
          timeBasis: 'execution-start',
          cohortAt: at,
          coveredByAcceptedRecords: false,
          metrics: completeObservationMetrics(full),
          issues: full.gaps,
        },
      },
    },
    model = {
      authority: 'local' as const,
      sourceId: null,
      provider: 'actual-provider',
      model: 'a',
    },
    query = { ...f.query, selection: JSON.stringify({ model }) },
    scopeGroups = new Map<string, HistoricalRecordScopeGroup>([
      [
        'a',
        {
          scopes: [execution],
          observed: true,
          model: { provider: 'actual-provider', id: 'a' },
          numeric: a,
        },
      ],
      [
        'b',
        {
          scopes: [execution],
          observed: true,
          model: { provider: 'actual-provider', id: 'b' },
          numeric: b,
        },
      ],
    ])
  const selected = incrementalObservationHistoricalScope(source, {
      ...f,
      query,
      ids: new Set(),
      scopeGroups,
    })!,
    document = selected.detail.document as CompleteHistoricalObservationExecution
  expect(document.metrics).toEqual(
    completeObservationMetrics({
      ...a,
      historicalReferences: '1',
      observedHistoricalReferences: '1',
      gaps: full.gaps,
    }),
  )
  expect(selected.fold.tokens).toEqual({ input: '0', cacheRead: '0', cacheWrite: '0', output: '0' })
  expect(document.scopeMatch).toBe('matched')
  const unknown = new Map(scopeGroups)
  unknown.set('b', { ...scopeGroups.get('b')!, model: null })
  const partial = incrementalObservationHistoricalScope(source, {
    ...f,
    query,
    ids: new Set(),
    scopeGroups: unknown,
  })!.detail.document as CompleteHistoricalObservationExecution
  expect(partial.metrics).toEqual(
    completeObservationMetrics({
      ...a,
      historicalReferences: '1',
      observedHistoricalReferences: '1',
      gaps: [...full.gaps, 'historical-scope-unresolved'],
    }),
  )
  expect(partial.scopeMatch).toBe('matched')
  expect(partial.issues).toEqual([...full.gaps, 'historical-scope-unresolved'])
  const nativeIssues = [
      ...full.gaps,
      'native-model-unavailable',
      'native-time-unavailable',
      'native-step-unfinished',
    ],
    withNativeIssues = incrementalObservationHistoricalScope(
      {
        ...source,
        detail: {
          ...source.detail,
          document: {
            ...(source.detail.document as CompleteHistoricalObservationExecution),
            metrics: completeObservationMetrics({ ...full, gaps: nativeIssues }),
            issues: nativeIssues,
          },
        },
      },
      { ...f, query, ids: new Set(), scopeGroups: unknown },
    )!.detail.document as CompleteHistoricalObservationExecution
  expect(withNativeIssues.scopeMatch).toBe('matched')
  expect(withNativeIssues.issues).toEqual([...nativeIssues, 'historical-scope-unresolved'])
  expect(
    incrementalObservationHistoricalScope(
      { ...source, detail: { ...source.detail, historicalRecordScopes: ['b'] } },
      { ...f, query, ids: new Set(), scopeGroups },
    ),
  ).toBeNull()
})
function fixture(scopes: readonly HistoricalObservationExecution[]) {
  const fold = emptyCompleteObservationFold()
  addCompleteObservationAllocation(
    fold,
    { input: '17', cacheRead: '19', cacheWrite: '23', output: '29' },
    { amount: null, complete: false, hidden: false },
  )
  const task: CompleteObservationTask = {
    task: {
      id: 'parent',
      name: 'Parent',
      status: 'done',
      parentTaskId: null,
      startedAt: at - 86400000,
      finishedAt: at - 1,
      runningMs: null,
      runningSince: null,
    },
    metrics: { state: 'not-applicable' },
    attemptCount: '0',
    timing: {
      wallMs: '1',
      runningMs: null,
      range: null,
      intervals: { state: 'complete', unknown: '0', cumulativeMs: '0', activeUnionMs: '0' },
    },
  }
  const row: QualifiedObservationContribution = {
    key: 'record',
    component: 'root',
    aggregates: [],
    fold,
    detail: {
      section: 'cohort-fold',
      key: 'record/native',
      parent: null,
      taskId: 'parent',
      cohortAt: task.task.startedAt,
      nativeRecord: true,
      document: null,
      scopes,
    },
  }
  const metadata: QualifiedObservationContribution = {
    ...row,
    detail: {
      section: 'tasks',
      key: 'parent',
      parent: null,
      taskId: 'parent',
      cohortAt: task.task.startedAt,
      document: task,
    },
  }
  return {
    row,
    originals: new Map([['parent', metadata]]),
    query: { from: at, to: at + 100, timezone: 'UTC' },
  }
}
test('memory/intent/diagnostic owners in the selected period remain visible when their parent Task is outside it', () => {
  for (const sourceKind of ['memory-distill', 'intent-turn', 'mcp-runtime-test'] as const) {
    const f = fixture([owner('memory', { sourceKind })]),
      row = incrementalObservationHistoricalScope(f.row, { ...f, ids: new Set() })!
    expect(row.detail.taskId).toBeNull()
    expect(row.detail.cohortAt).toBe(at)
    expect(row.fold.tokens.input).toBe('17')
  }
})
test('a NodeRun follows its Task cohort and cannot substitute its execution clock', () => {
  const f = fixture([owner('node', { sourceKind: 'task' })])
  expect(incrementalObservationHistoricalScope(f.row, { ...f, ids: new Set() })).toBeNull()
  expect(
    incrementalObservationHistoricalScope(f.row, { ...f, ids: new Set(['parent']) })?.detail
      .cohortAt,
  ).toBe(at - 86400000)
})
test('a root shared by included/excluded owners exposes an unresolved gap without allocating its numerical value twice', () => {
  const f = fixture([
    owner('included'),
    owner('excluded', { parentTaskId: null, startedAt: at - 1, createdAt: at - 1 }),
  ])
  const row = incrementalObservationHistoricalScope(f.row, { ...f, ids: new Set() })!
  expect(row.fold.tokens.input).toBe('0')
  expect(row.fold.gaps).toContain('historical-scope-unresolved')
})
test('owner search/status and project filters preserve the original exclusions', () => {
  const f = fixture([owner('memory')])
  for (const query of [
    { ...f.query, status: 'failed' as const },
    { ...f.query, q: 'unrelated' },
    { ...f.query, workflow: 'other' },
    { ...f.query, repository: 'other' },
  ])
    expect(incrementalObservationHistoricalScope(f.row, { ...f, query, ids: new Set() })).toBeNull()
})
test('unknown owner clocks remain unresolved and local days use the requested DST timezone', () => {
  const f = fixture([owner('unknown', { parentTaskId: null, createdAt: null, startedAt: null })]),
    row = incrementalObservationHistoricalScope(f.row, { ...f, ids: new Set() })!
  expect(row.detail.cohortAt).toBeNull()
  expect(row.fold.gaps).toContain('historical-scope-unresolved')
  const clockA = Date.parse('2026-10-24T22:30:00Z'),
    clockB = Date.parse('2026-10-25T01:30:00Z'),
    dst = fixture([
      owner('a', { parentTaskId: null, startedAt: clockA }),
      owner('b', { parentTaskId: null, startedAt: clockB }),
    ])
  expect(
    incrementalObservationHistoricalScope(dst.row, {
      ...dst,
      ids: new Set(),
      query: { from: clockA, to: clockB + 1, timezone: 'Europe/Berlin' },
    })?.detail.cohortAt,
  ).toBe(clockA)
})

// Windows exact-SHA CI exposed loss of historical coverage while rebuilding an unchanged time row.
test('matched native time partitions preserve their independently sealed reference coverage and all received buckets including zero', () => {
  for (const tokens of [
    { input: '9007199254740997', cacheRead: '19', cacheWrite: '23', output: '29' },
    { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
  ]) {
    const f = fixture([owner('memory')]),
      metrics = completeObservationMetrics({
        ...f.row.fold,
        tokens,
        historicalReferences: '1',
        observedHistoricalReferences: '1',
        gaps: ['native-model-unavailable'],
      }),
      document = {
        identity: 'historical/memory',
        kind: 'historical',
        task: null,
        invocation: null,
        sourceId: 'original',
        recordId: 'original-record',
        partition: 'in-window',
        occurrence: { occurredAt: at, basis: 'native-step' },
        metrics,
      },
      original = {
        ...f.row,
        detail: { ...f.row.detail, section: 'time-partitions' as const, document },
      },
      scoped = incrementalObservationHistoricalScope(original, { ...f, ids: new Set() })!
    expect(scoped.detail.document).toEqual(document)
    expect(scoped.detail.document).toBe(document)
    expect(scoped.fold).toEqual(original.fold)
    expect(metrics.state).toBe('not-ready')
    if (metrics.state !== 'not-ready') throw new Error('Original received metrics fixture missing')
    expect(metrics.tokenCoverage?.historicalReferences).toBe('1')
    expect(metrics.tokenCoverage?.observedHistoricalReferences).toBe('1')
    expect(metrics.recordedUsage?.tokens).toMatchObject(tokens)
  }
})

test('a shared physical candidate keeps both references unresolved even when one own execution is excluded', () => {
  const included = owner('included', { parentTaskId: null, status: 'done' }),
    excluded = owner('excluded', { parentTaskId: 'outside', status: 'failed' }),
    f = fixture([included, excluded]),
    query = { ...f.query, cohort: 'usage' as const, status: 'done' as const },
    scopeGroups = new Map([
      [
        'shared',
        {
          scopes: [included, excluded],
          observed: true,
          model: null,
          numeric: emptyCompleteObservationFold(),
        },
      ],
    ]),
    oldFold = {
      ...emptyCompleteObservationFold(),
      historicalReferences: '1',
      observedHistoricalReferences: '1',
      gaps: [
        'historical-invocation-unobserved',
        'historical-attribution-unresolved',
        'native-model-unavailable',
      ],
    }
  const historical: CompleteHistoricalObservationExecution[] = []
  for (const execution of [included, excluded]) {
    const document: CompleteHistoricalObservationExecution = {
      execution,
      referenceRole: 'execution',
      parentTaskName: null,
      scopeMatch: 'matched',
      timeBasis: 'execution-start',
      cohortAt: at,
      coveredByAcceptedRecords: false,
      metrics: completeObservationMetrics(oldFold),
      issues: oldFold.gaps,
    }
    const scoped = incrementalObservationHistoricalScope(
      {
        ...f.row,
        fold: oldFold,
        detail: {
          ...f.row.detail,
          section: 'historical-executions',
          document,
          nativeRecord: false,
          scopes: [execution],
          historicalRecordScopes: ['shared'],
        },
      },
      { ...f, query, ids: new Set(), scopeGroups },
    )!
    expect(scoped).not.toBeNull()
    const actual = scoped.detail.document as CompleteHistoricalObservationExecution
    expect(actual.scopeMatch).toBe('unresolved')
    expect(actual.execution).toEqual(execution)
    expect(actual.metrics).toEqual(
      completeObservationMetrics({
        ...oldFold,
        observedHistoricalReferences: '0',
        gaps: [...oldFold.gaps, 'historical-scope-unresolved'],
      }),
    )
    // The original allocator diagnoses an unresolved execution scope before
    // attribution, while retaining the original native issue sequence.
    expect(actual.issues).toEqual([
      'historical-invocation-unobserved',
      'historical-scope-unresolved',
      ...oldFold.gaps.slice(1),
    ])
    historical.push(actual)
  }
  const unresolved = incrementalObservationHistoricalScope(f.row, { ...f, query, ids: new Set() })!,
    time = {
      ...unresolved,
      detail: {
        ...unresolved.detail,
        section: 'time-partitions' as const,
        document: {
          identity: 'shared-original',
          kind: 'historical',
          sourceId: 'original',
          recordId: 'record',
          task: null,
          invocation: null,
          partition: 'in-window',
          occurrence: { occurredAt: at, basis: 'native-step' },
          referenceIds: ['included', 'excluded'],
          candidateCount: '2',
          model: null,
          metrics: completeObservationMetrics(unresolved.fold),
        },
      },
    },
    window = incrementalObservationWindow({
      query,
      tasks: [],
      invocations: [],
      historical,
      occurrences: [time],
    })
  expect(window.fold.historicalReferences).toBe('2')
  expect(window.fold.observedHistoricalReferences).toBe('0')
  expect(window.fold.records).toBe('0')
  expect(window.fold.tokens).toEqual({ input: '0', cacheRead: '0', cacheWrite: '0', output: '0' })
  expect(window.timeRows).toEqual([])
  expect(window.tasks).toEqual([])
  expect(window.historical.map((row) => row.execution.referenceId)).toEqual([
    'included',
    'excluded',
  ])
  // The admitted usage page must agree with the zero numerical inventory;
  // the same physical fact is still present in the original-source diagnostic.
  const originalRecord = {
    nativeSource: 'original',
    recordId: 'shared-record',
    occurredAt: at,
    includedInTotals: false,
    metrics: completeObservationMetrics(unresolved.fold),
  }
  expect(
    incrementalObservationWindowRows([originalRecord], 'historical-records', null, window, [], at),
  ).toEqual([])
  expect(
    incrementalObservationWindowRows(
      [originalRecord],
      'historical-records',
      'original-source',
      window,
      [],
      at,
    ),
  ).toEqual([originalRecord])
  expect(
    incrementalObservationWindowRows(
      [originalRecord],
      'historical-records',
      null,
      { ...window, mode: 'cohort' },
      [],
      at,
    ),
  ).toEqual([originalRecord])
})

test('distinct physical candidate sets preserve a uniquely observed record and do not count a covered record as observed', () => {
  const included = owner('included', { parentTaskId: null, status: 'done' }),
    excluded = owner('excluded', { parentTaskId: null, status: 'failed' }),
    f = fixture([included]),
    query = { ...f.query, cohort: 'usage' as const, status: 'done' as const },
    scopeGroups = new Map([
      ['unique', { scopes: [included], observed: true, model: null, numeric: f.row.fold }],
      [
        'shared',
        {
          scopes: [included, excluded],
          observed: true,
          model: null,
          numeric: emptyCompleteObservationFold(),
        },
      ],
    ]),
    source = {
      ...f.row,
      fold: { ...f.row.fold, historicalReferences: '1', observedHistoricalReferences: '1' },
      detail: {
        ...f.row.detail,
        nativeRecord: false,
        historicalRecordScopes: ['unique', 'shared'],
      },
    }
  const actual = incrementalObservationHistoricalScope(source, {
    ...f,
    query,
    ids: new Set(),
    scopeGroups,
  })!
  expect(actual.fold.tokens).toEqual(source.fold.tokens)
  expect(actual.fold.records).toBe(source.fold.records)
  expect(actual.fold.observedHistoricalReferences).toBe('1')
  expect(actual.fold.gaps).toContain('historical-scope-unresolved')
  const coveredGroups = new Map(scopeGroups)
  coveredGroups.set('covered', {
    scopes: [included],
    observed: false,
    model: null,
    numeric: emptyCompleteObservationFold(),
  })
  const covered = incrementalObservationHistoricalScope(
    { ...source, detail: { ...source.detail, historicalRecordScopes: ['covered', 'shared'] } },
    { ...f, query, ids: new Set(), scopeGroups: coveredGroups },
  )!
  expect(covered.fold.observedHistoricalReferences).toBe('0')
  expect(
    incrementalObservationHistoricalScope(source, {
      ...f,
      query: { ...query, q: 'neither-original-owner' },
      ids: new Set(),
      scopeGroups,
    }),
  ).toBeNull()
})
