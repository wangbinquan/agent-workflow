// RFC-371: ranges/pages must reuse a committed projection rather than trigger
// original numerical reads. Overlapping periods never truncate the population.
import { expect, test } from 'bun:test'
import type { Actor } from '@/auth/actor'
import { buildActor } from '@/auth/actor'
import type {
  CompleteObservationInvocation,
  CompleteObservationReport,
  CompleteObservationTask,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { incrementalObservationQueries } from '@/modules/run-observability/application/incrementalObservationQueries'
import { incrementalObservationPopulation } from '@/modules/run-observability/domain/incrementalObservationPopulation'
import { incrementalObservationTiming } from '@/modules/run-observability/application/incrementalObservationTiming'
import {
  emptyCompleteObservationFold,
  addCompleteObservationAllocation,
  completeObservationMetrics,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import {
  emptyIncrementalObservationFold,
  replaceIncrementalObservationContribution,
} from '@/modules/run-observability/domain/incrementalObservationFold'
import type {
  IncrementalObservationQuerySource,
  ObservationProjectionView,
} from '@/modules/run-observability/ports/incrementalObservationQueries'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'

const DAY = 86400000,
  NOW = Date.parse('2026-10-12T00:00:00Z')
const actor: Actor = buildActor({
  source: 'session',
  user: { id: 'owner', username: 'owner', displayName: 'Owner', role: 'admin', status: 'active' },
})
function content(report: CompleteObservationReport) {
  if (report.state === 'ready') return report
  if (report.state === 'not-ready' && report.facts) return report.facts
  throw new Error('Projection content is missing')
}
function fixture() {
  const rows: QualifiedObservationContribution[] = [],
    aggregates = new Map<string, ReturnType<typeof emptyIncrementalObservationFold>>(),
    views = new Map<string, ObservationProjectionView>()
  const visible = new Set<string>(),
    reads: string[] = [],
    days: [number, number][] = []
  for (let n = 0; n < 270; n++) {
    const id = 'task-' + String(n).padStart(4, '0'),
      at = NOW - n * DAY,
      fold = emptyCompleteObservationFold('1')
    fold.observedInvocations = '1'
    addCompleteObservationAllocation(
      fold,
      { input: String(n + 1), cacheRead: '2', cacheWrite: '3', output: '5' },
      { amount: '0.000000000001', complete: true, hidden: false },
    )
    const task: CompleteObservationTask = {
      task: {
        id,
        name: 'Task ' + n,
        status: 'done',
        parentTaskId: null,
        startedAt: at,
        finishedAt: at + 10,
        runningMs: 5,
        runningSince: null,
      },
      metrics: completeObservationMetrics(fold),
      attemptCount: '1',
      timing: {
        wallMs: '10',
        runningMs: '5',
        range: null,
        intervals: { state: 'complete', unknown: '0', cumulativeMs: '5', activeUnionMs: '5' },
      },
    }
    const call: CompleteObservationInvocation = {
      invocationId: 'call-' + id,
      taskId: id,
      nodeRunId: 'attempt-' + id,
      agentId: 'agent',
      agentRevision: 1,
      purpose: 'task',
      authority: { kind: 'local', runtime: null },
      acceptedAt: at,
      priceBookRevision: 0,
      metrics: task.metrics,
      taskName: task.task.name,
      agentName: 'Agent',
    }
    const inventory = { tasks: '1', attempts: '1', nativeCaptures: '1', numericRecords: '1' }
    aggregates.set(
      'task/' + id,
      replaceIncrementalObservationContribution(emptyIncrementalObservationFold(), null, {
        ...fold,
        inventory,
      }),
    )
    visible.add(id)
    rows.push({
      key: id,
      component: id,
      fold: emptyCompleteObservationFold(),
      aggregates: [],
      detail: { section: 'tasks', parent: null, key: id, taskId: id, cohortAt: at, document: task },
    })
    rows.push({
      key: 'call/' + id,
      component: id,
      fold: { ...fold, inventory },
      aggregates: [],
      detail: {
        section: 'invocations',
        parent: null,
        key: call.invocationId,
        taskId: id,
        cohortAt: at,
        document: call,
      },
    })
    const atom = { ...fold, invocations: '0', observedInvocations: '0' }
    rows.push({
      key: 'time/' + id,
      component: id,
      fold: atom,
      aggregates: [],
      detail: {
        section: 'time-partitions',
        parent: null,
        key: id,
        taskId: id,
        cohortAt: at + 1,
        document: {
          identity: id,
          sourceId: 'source',
          recordId: id,
          task: task.task,
          invocation: call,
          occurrence: {
            occurredAt: at + 1,
            observedAt: at + 1,
            source: 'measurement',
            state: 'observed',
          },
          partition: 'in-window',
          metrics: completeObservationMetrics(atom),
          referenceIds: [],
          model: { provider: 'provider', id: 'actual-model' },
        },
      },
    })
  }
  const source: IncrementalObservationQuerySource = {
    snapshot: async () => ({ revision: '1', asOf: NOW + 100 }),
    bootstrapComplete: async () => true,
    aggregate: async (key) => aggregates.get(key) ?? null,
    aggregates: async (keys) => {
      reads.push('aggregates')
      return new Map(
        keys.flatMap((key) => (aggregates.has(key) ? [[key, aggregates.get(key)!] as const] : [])),
      )
    },
    async *details(input) {
      reads.push(input.section)
      for (const row of rows)
        if (
          row.detail.section === input.section &&
          (input.parent === undefined || row.detail.parent === input.parent) &&
          (input.taskIds === undefined || input.taskIds.includes(row.detail.taskId!)) &&
          (input.components === undefined || input.components.includes(row.component)) &&
          (!input.standalone || row.detail.taskId === null)
        )
          yield row
    },
    async *days(input) {
      days.push([input.from, input.to])
      for (const row of rows)
        if (
          row.detail.section === 'time-partitions' &&
          input.taskIds.includes(row.detail.taskId!) &&
          Math.floor(row.detail.cohortAt! / DAY) * DAY >= Math.ceil(input.from / DAY) * DAY &&
          Math.floor(row.detail.cohortAt! / DAY) * DAY < Math.floor(input.to / DAY) * DAY
        )
          yield replaceIncrementalObservationContribution(
            emptyIncrementalObservationFold(),
            null,
            row.fold,
          )
    },
    async *identities(input) {
      for (const row of rows)
        if (
          row.detail.parent === null &&
          (input.taskIds === undefined || input.taskIds.includes(row.detail.taskId!)) &&
          (input.components === undefined || input.components.includes(row.component))
        )
          yield {
            section: row.detail.section,
            key: row.detail.key,
            component: row.component,
            detail: row.detail,
          }
    },
    counts: async () => {
      throw new Error('Packet DISTINCT counts must not be added together')
    },
    visibleTaskIds: async (_actor, ids) => ids.filter((id) => visible.has(id)),
    retainView: async (value) => {
      const view = { ...value, id: sha256Hex(JSON.stringify(value)) }
      views.set(view.id, view)
      return view
    },
    activateView: async (id, _actor, version) => {
      const old = views.get(id)
      if (!old) throw new Error('Missing view')
      const view = old.version.revision === '0' ? { ...old, version } : old
      views.set(id, view)
      return view
    },
    view: async (id) => {
      const view = views.get(id)
      if (!view) throw new Error('Missing view')
      return view
    },
  }
  return {
    queries: incrementalObservationQueries({
      source,
      generation: 'fixture',
      scopeOf: (actor) => actor.user.id,
      keyOf: sha256Hex,
    }),
    source,
    rows,
    reads,
    days,
    visible,
  }
}
test('all 270 Tasks are included past the old 100/200 thresholds, and pagination never supplies the summary', async () => {
  const f = fixture(),
    report = content(
      await f.queries.request(actor, { from: 0, to: NOW + 1, timezone: 'UTC' }, 'all'),
    )
  expect(report.summary.inventory.tasks).toBe('270')
  expect(report.summary.metrics.state).toBe('ready')
  if (report.summary.metrics.state === 'ready') {
    expect(report.summary.metrics.tokens.input).toBe(String((270 * 271) / 2))
    expect(report.summary.metrics.tokens.cacheWrite).toBe('810')
    expect(report.summary.metrics.cost).toEqual({
      currency: 'CNY',
      state: 'complete',
      amount: '0.00000000027',
    })
  }
  const first = await f.queries.page(actor, report.header.reportId, {
      section: 'tasks',
      limit: 200,
    }),
    second = await f.queries.page(actor, report.header.reportId, {
      section: 'tasks',
      limit: 200,
      after: first.nextCursor,
    })
  expect(first.items).toHaveLength(200)
  expect(second.items).toHaveLength(70)
  expect(second.nextCursor).toBeNull()
  expect(second.total).toBe('270')
  expect(content(await f.queries.status(actor, report.header.reportId)).summary).toEqual(
    report.summary,
  )
})
test('7/30 day cohorts reuse one materialized numerical generation and a page does not rebuild it', async () => {
  const f = fixture()
  for (const days of [7, 30, 7]) {
    const report = content(
      await f.queries.request(
        actor,
        { from: NOW - (days - 1) * DAY, to: NOW + 1, timezone: 'UTC' },
        String(days),
      ),
    )
    expect(report.header.sourceRevision).toBe('1')
    expect(report.summary.inventory.tasks).toBe(String(days))
    if (report.summary.metrics.state === 'ready')
      expect(report.summary.metrics.tokens.input).toBe(String((days * (days + 1)) / 2))
    await f.queries.page(actor, report.header.reportId, { section: 'tasks', limit: 50 })
  }
  expect(f.reads.filter((key) => key === 'aggregates')).toHaveLength(2)
})
test('usage periods consume reusable complete days with half-open edge records and distinct calls', async () => {
  const f = fixture(),
    filters = {
      from: NOW - 6 * DAY,
      to: NOW + DAY,
      timezone: 'Asia/Shanghai',
      cohort: 'usage' as const,
    }
  const report = content(await f.queries.request(actor, filters, 'week'))
  expect(report.summary.inventory.invocations).toBe('7')
  expect(
    'nativeCaptures' in report.summary.inventory ? report.summary.inventory.nativeCaptures : null,
  ).toBe('7')
  if (report.summary.metrics.state === 'ready')
    expect(report.summary.metrics.tokens.input).toBe('28')
  expect(f.days).toEqual([[filters.from, filters.to]])
  const exact = content(
    await f.queries.request(actor, { ...filters, from: NOW + 1, to: NOW + 2 }, 'edge'),
  )
  if (exact.summary.metrics.state === 'ready') expect(exact.summary.metrics.tokens.input).toBe('1')
})
test('revocation revalidates current visibility even when the retained summary and pages were cached', async () => {
  const f = fixture(),
    report = content(
      await f.queries.request(actor, { from: 0, to: NOW + 1, timezone: 'UTC' }, 'all'),
    )
  f.visible.delete('task-0000')
  const current = content(await f.queries.status(actor, report.header.reportId))
  expect(current.summary.inventory.tasks).toBe('269')
  const page = await f.queries.page<CompleteObservationTask>(actor, report.header.reportId, {
    section: 'tasks',
    limit: 200,
  })
  expect(page.items.some((row) => row.task.id === 'task-0000')).toBe(false)
  expect(page.total).toBe('269')
})
test('initial backfill retains one report ID through building/ready', async () => {
  const f = fixture()
  let complete = false
  f.source.bootstrapComplete = async () => complete
  const initial = await f.queries.request(
    actor,
    { from: 0, to: NOW + 1, timezone: 'UTC' },
    'initial',
  )
  expect(initial.state).toBe('building')
  if (initial.state !== 'building') throw new Error('Expected pending enumeration')
  complete = true
  const ready = content(await f.queries.status(actor, initial.reportId))
  expect(ready.header.reportId).toBe(initial.reportId)
  expect(ready.summary.inventory.tasks).toBe('270')
})
test('a complete population with a native gap still returns its known Token buckets and RMB amount', async () => {
  const f = fixture(),
    original = f.source.aggregates
  f.source.aggregates = async (keys, version) =>
    new Map(
      [...(await original(keys, version))].map(([key, fold]) => [
        key,
        { ...fold, gaps: { ...fold.gaps, 'historical-native-unavailable': '1' } },
      ]),
    )
  const report = await f.queries.request(
    actor,
    { from: 0, to: NOW + 1, timezone: 'UTC' },
    'known-partial',
  )
  expect(report.state).toBe('not-ready')
  const facts = content(report)
  expect(facts.summary.inventory.tasks).toBe('270')
  if (facts.summary.metrics.state !== 'not-ready') throw new Error('Expected a visible native gap')
  expect(facts.summary.metrics.gaps).toContain('historical-native-unavailable')
  expect(facts.summary.metrics.recordedUsage?.tokens.input).toBe(String((270 * 271) / 2))
  expect(facts.summary.metrics.recordedCost?.currency).toBe('CNY')
})
test('a requested Task whose current visibility is revoked returns the existing not-found behavior', async () => {
  const f = fixture()
  f.visible.delete('task-0000')
  await expect(
    f.queries.request(actor, { from: 0, to: NOW + 1, timezone: 'UTC' }, 'root', 'task-0000'),
  ).rejects.toMatchObject({ code: 'not-found' })
})
test('a retained root includes 1007 descendants beyond its date range without any Task cap', () => {
  const f = fixture(),
    parent = f.rows[0]!,
    base = parent.detail.document as CompleteObservationTask
  const rows = [
    parent,
    ...Array.from(
      { length: 1007 },
      (_, n): QualifiedObservationContribution => ({
        ...parent,
        key: 'child-' + n,
        detail: {
          ...parent.detail,
          key: 'child-' + n,
          document: {
            ...base,
            task: {
              ...base.task,
              id: 'child-' + n,
              parentTaskId: base.task.id,
              startedAt: NOW + DAY,
            },
          },
        },
      }),
    ),
  ]
  expect(
    incrementalObservationPopulation(rows, { from: 0, to: NOW + 1, timezone: 'UTC' }, base.task.id)
      .ids.size,
  ).toBe(1008)
})
test('a root merges descendant parallel intervals and recomputes open clocks at the retained asOf', async () => {
  const task = (fixture().rows[0]!.detail.document as CompleteObservationTask).task
  const original = { ...task, startedAt: 0, finishedAt: null, runningMs: 10, runningSince: 100 }
  const child = { ...original, id: 'child' },
    attempts = [
      {
        task: original,
        attempt: {
          id: 'a',
          nodeId: 'A',
          retryIndex: 0,
          iteration: 0,
          wgRound: null,
          reviewIteration: 0,
          status: 'done' as const,
          startedAt: 10,
          finishedAt: 90,
        },
      },
      {
        task: child,
        attempt: {
          id: 'b',
          nodeId: 'B',
          retryIndex: 0,
          iteration: 0,
          wgRound: null,
          reviewIteration: 0,
          status: 'running' as const,
          startedAt: 50,
          finishedAt: null,
        },
      },
    ]
  const timing = await incrementalObservationTiming(original, attempts, 150)
  expect(timing.wallMs).toBe('150')
  expect(timing.runningMs).toBe('60')
  expect(timing.intervals).toEqual({
    state: 'complete',
    unknown: '0',
    cumulativeMs: '180',
    activeUnionMs: '140',
  })
})
