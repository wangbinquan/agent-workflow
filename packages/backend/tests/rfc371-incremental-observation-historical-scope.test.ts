// RFC-371: historical membership keeps original owner clocks, root ambiguity,
// filtering and DST semantics without repeating native reads or allocation.
import { expect, test } from 'bun:test'
import type {
  CompleteObservationTask,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import { incrementalObservationHistoricalScope } from '@/modules/run-observability/application/incrementalObservationHistoricalScope'
import {
  emptyCompleteObservationFold,
  addCompleteObservationAllocation,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'

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
