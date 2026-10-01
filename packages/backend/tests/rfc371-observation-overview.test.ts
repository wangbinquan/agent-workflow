import { expect, test } from 'bun:test'
import type {
  AcceptedObservationInvocation,
  ObservationMetrics,
  ObservationTaskFacts,
  ObservationRuntimeSummary,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../src/modules/run-observability/domain/usageLedger'
import { buildActor } from '../src/auth/actor'
import { aggregateObservationMetrics as aggregate } from '../src/modules/run-observability/domain/aggregateMetrics'
import { createTaskObservationQueries } from '../src/modules/run-observability/application/taskObservations'
import { readDimensionTasks } from '../src/modules/run-observability/application/dimensionTasks'
import { readObservationOverview } from '../src/modules/run-observability/application/observationOverview'
import type { ObservationSnapshotSources } from '../src/modules/run-observability/ports/taskObservations'

const actor = buildActor({
  user: {
    id: 'reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
function metrics(input: string, amount: string | null): ObservationMetrics {
  return {
    invocations: 1,
    observedInvocations: 1,
    records: 1,
    tokens: {
      known: { input, cacheRead: '0', cacheWrite: '0', output: '0' },
      totalKnown: input,
      hasKnown: true,
      complete: true,
      unknownBuckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
    cost: {
      currency: 'CNY',
      knownAmount: amount,
      complete: amount !== null,
      pricedRecords: amount === null ? 0 : 1,
      priceVersionIds: amount === null ? [] : ['frozen-price'],
      reasons: amount === null ? ['unpriced'] : [],
    },
    authorities: ['local'],
    truncated: false,
  }
}

test('aggregation keeps arbitrary-size tokens, pico-yuan fractions and null distinct from measured zero', () => {
  const huge = metrics('90071992547409930001', '1.000000000001'),
    zero = metrics('0', '0'),
    unknown = metrics('9', null)
  const result = aggregate([huge, zero, unknown])
  expect(result.tokens.totalKnown).toBe('90071992547409930010')
  expect(result.cost.knownAmount).toBe('1.000000000001')
  expect(result.cost.complete).toBe(false)
  expect(result.cost.priceVersionIds).toEqual(['frozen-price'])
  expect(aggregate([zero]).cost.knownAmount).toBe('0')
  expect(aggregate([unknown]).cost.knownAmount).toBeNull()
  expect(aggregate([]).tokens.hasKnown).toBe(false)
  expect(aggregate([]).cost.knownAmount).toBeNull()
  expect(aggregate([huge], true).tokens.complete).toBe(false)
  expect(aggregate([huge], true).cost.reasons).toContain('truncated')
})

function fixture(count: number) {
  const tasks: ObservationTaskFacts[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    name: String(i),
    status: 'done',
    parentTaskId: null,
    startedAt: i,
    finishedAt: i + 1,
    runningMs: 1,
    runningSince: null,
  }))
  const sources: ObservationSnapshotSources = {
    tasks: {
      async sourceBacklog(taskIds) {
        return taskIds.map((taskId) => ({ taskId, retainedRecords: 0, pendingRecords: 0 }))
      },
      async list({ query }) {
        const start = Number(query.after ?? 0)
        return {
          items: tasks.slice(start, start + query.limit),
          positions: tasks.slice(start, start + query.limit).map((task, index) => ({
            taskId: task.id,
            cursor: String(start + index + 1),
          })),
          nextCursor: start + query.limit < tasks.length ? String(start + query.limit) : null,
        }
      },
      async get() {
        return null
      },
      async attempts() {
        return { items: [], truncated: false }
      },
    },
    async invocations() {
      return { items: [], truncated: false }
    },
    local: {
      async captures() {
        return []
      },
      async records() {
        return { items: [] }
      },
    },
    platform: {
      async records() {
        throw new Error('Unexpected platform read')
      },
    },
    async value() {
      throw new Error('Unexpected valuation')
    },
  }
  return {
    actor,
    query: { from: 0, to: 1000, timezone: 'UTC' },
    asOf: 1000,
    sources,
    async summarize(_sources: ObservationSnapshotSources, task: ObservationTaskFacts) {
      return {
        summary: { task, metrics: metrics('1', '0.000001'), wallMs: 1, runningMs: 1 },
        agents: [],
        models: [],
        runtimes: [],
        collection: { firstObservedAt: null, lastObservedAt: null, platforms: [] },
      }
    },
  }
}

test('overview marks a bounded read partial and never labels the loaded 200 tasks as a complete cohort', async () => {
  const result = await readObservationOverview(fixture(201))
  expect(result.tasks).toHaveLength(200)
  expect(result.partial).toBe(true)
  expect(result.metrics.tokens.totalKnown).toBe('200')
  expect(result.metrics.cost.knownAmount).toBe('0.0002')
  expect(result.metrics.tokens.complete).toBe(false)
  expect(result.trend[0]!.metrics.tokens.complete).toBe(false)
  expect((await readObservationOverview(fixture(200))).partial).toBe(false)
  expect((await readObservationOverview(fixture(0))).metrics.cost.knownAmount).toBeNull()
})

test('bounded runtime groups reconcile only their own task contributions without numeric precision loss', async () => {
  const f = fixture(201)
  const result = await readObservationOverview({
    ...f,
    async summarize(sources, task) {
      const row = await f.summarize(sources, task)
      const value = metrics(
        task.id === '0' ? '9007199254740993' : '0',
        task.id === '0' ? '1.000000000001' : '0',
      )
      const runtimes: ObservationRuntimeSummary[] = [
        {
          authority: 'local',
          sourceId: null,
          registrationId: 'registered',
          configurationRevision: 7,
          protocol: 'opencode',
          acceptedNames: task.id === '0' ? [] : ['original'],
          unnamedInvocations: task.id === '0' ? 1 : 0,
          metrics: value,
        },
      ]
      if (task.id === '0')
        runtimes.push({
          ...runtimes[0]!,
          registrationId: 'other-runtime',
          acceptedNames: ['original'],
          unnamedInvocations: 0,
          metrics: metrics('99', null),
        })
      return {
        ...row,
        summary: { ...row.summary, metrics: aggregate(runtimes.map((runtime) => runtime.metrics)) },
        runtimes,
      }
    },
  })
  expect(result.partial).toBe(true)
  const primary = result.runtimes.find((row) => row.registrationId === 'registered')!
  expect(primary.acceptedNames).toEqual(['original'])
  expect(primary.unnamedInvocations).toBe(1)
  expect(primary.tasks).toHaveLength(200)
  expect(primary.metrics.tokens.totalKnown).toBe('9007199254740993')
  expect(primary.metrics.cost.knownAmount).toBe('1.000000000001')
  expect(primary.metrics.tokens.complete).toBe(false)
  expect(primary.metrics.cost.reasons).toContain('truncated')
  for (const group of result.runtimes)
    expect(
      aggregate(
        group.tasks!.map((row) => row.metrics),
        result.partial,
      ),
    ).toEqual(group.metrics)
  expect(result.tasks[0]!.metrics.tokens.totalKnown).toBe('9007199254741092')
})

test('ordinary data-source failures propagate instead of masquerading as partial successful statistics', async () => {
  const f = fixture(1)
  await expect(
    readObservationOverview({
      ...f,
      summarize: async () => {
        throw new Error('database disconnected')
      },
    }),
  ).rejects.toThrow('database disconnected')
  f.sources.tasks.sourceBacklog = async () => {
    throw new Error('source status unavailable')
  }
  await expect(readObservationOverview(f)).rejects.toThrow('source status unavailable')
})

// A budget breach must omit the incomplete task, not return its earlier pages as a full total.
test('shared record budget caps requests and discards a task interrupted midway', async () => {
  const f = fixture(2)
  const usage = { input: '1', cacheRead: '0', cacheWrite: '0', output: '0' }
  const record = {
    sourceId: 'source',
    observedRevision: 1,
    contribution: usage,
    complete: true,
    issues: [],
    measurement: {
      schemaVersion: 1,
      invocationId: 'invocation',
      taskId: 'task',
      nodeRunId: null,
      agentId: null,
      recordId: 'record',
      revision: 1,
      occurredAt: 1,
      observedAt: 1,
      model: null,
      adapterVersion: 'fixture',
      reporting: 'delta',
      inclusion: 'self',
      coverage: 'complete',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage,
    },
  } satisfies UsageLedgerRecord
  const limits: number[] = []
  const sources: ObservationSnapshotSources = {
    ...f.sources,
    local: {
      captures: f.sources.local.captures,
      async records(_taskId, query) {
        limits.push(query.limit)
        return { items: Array.from({ length: query.limit }, () => record), nextCursor: 'more' }
      },
    },
  }
  const result = await readObservationOverview({
    ...f,
    sources,
    async summarize(bounded, task) {
      if (task.id === '0') await bounded.local.records(task.id, { limit: 19_999 })
      else {
        await bounded.local.records(task.id, { limit: 500 })
        await bounded.local.records(task.id, { limit: 500, after: 'more' })
      }
      return f.summarize(bounded, task)
    },
  })
  expect(limits).toEqual([19_999, 1])
  expect(result.partial).toBe(true)
  expect(result.tasks.map((row) => row.task.id)).toEqual(['0'])
  expect(result.metrics.tokens.totalKnown).toBe('1')
})

test('shared invocation budget stops before an extra task contributes any metrics', async () => {
  const f = fixture(11)
  let reads = 0
  const invocation = {
    invocationId: 'id',
    taskId: 'task',
    nodeRunId: null,
    agentId: null,
    agentRevision: null,
    purpose: 'task',
    authority: { kind: 'local', runtime: null },
    acceptedAt: 1,
    priceBookRevision: null,
  } satisfies AcceptedObservationInvocation
  const sources: ObservationSnapshotSources = {
    ...f.sources,
    async invocations() {
      reads++
      return { items: Array.from({ length: 1000 }, () => invocation), truncated: false }
    },
  }
  const result = await readObservationOverview({
    ...f,
    sources,
    async summarize(bounded, task) {
      await bounded.invocations(task.id)
      return f.summarize(bounded, task)
    },
  })
  expect(reads).toBe(10)
  expect(result.tasks).toHaveLength(10)
  expect(result.partial).toBe(true)
  expect(result.metrics.tokens.totalKnown).toBe('10')
})

function unresolvedTask(task: ObservationTaskFacts) {
  return {
    summary: {
      task,
      metrics: aggregate([], true),
      wallMs: 1,
      runningMs: 1,
      dimensionMatch: 'unresolved' as const,
    },
    agents: [],
    models: [],
    runtimes: [],
    collection: { firstObservedAt: null, lastObservedAt: null, platforms: [] },
  }
}

test('dimension no-match scanning stops at raw task budget and continues beyond an empty partial batch', async () => {
  const f = fixture(205),
    query = { ...f.query, selection: JSON.stringify({ purpose: 'task' }), limit: 20 }
  const input = {
    ...f,
    query,
    unresolved: unresolvedTask,
    summarize: async (sources: ObservationSnapshotSources, task: ObservationTaskFacts) =>
      task.id === '204' ? f.summarize(sources, task) : null,
  }
  const first = await readDimensionTasks(input)
  expect(first.rows).toHaveLength(0)
  expect(first.scannedTasks).toBe(200)
  expect(first.partial).toBe(true)
  expect(first.nextCursor).not.toBeNull()
  const second = await readDimensionTasks({
    ...input,
    query: { ...query, after: first.nextCursor! },
  })
  expect(second.rows.map((row) => row.summary.task.id)).toEqual(['204'])
  expect(second.scannedTasks).toBe(5)
  expect(second.nextCursor).toBeNull()
})

test('an oversized first dimension task advances only with its unresolved facts row and reaches a following match', async () => {
  const f = fixture(2),
    query = { ...f.query, selection: JSON.stringify({ purpose: 'task' }), limit: 1 },
    record = {} as UsageLedgerRecord,
    limits: number[] = []
  f.sources.local.records = async (_task, request) => {
    limits.push(request.limit)
    return { items: Array.from({ length: request.limit }, () => record), nextCursor: 'more' }
  }
  const input = {
    ...f,
    query,
    unresolved: unresolvedTask,
    summarize: async (sources: ObservationSnapshotSources, task: ObservationTaskFacts) => {
      if (task.id === '0') {
        await sources.local.records(task.id, { limit: 10_000 })
        await sources.local.records(task.id, { limit: 10_000, after: 'more' })
        await sources.local.records(task.id, { limit: 1, after: 'still-more' })
      }
      return f.summarize(sources, task)
    },
  }
  const first = await readDimensionTasks(input)
  expect(limits).toEqual([10_000, 10_000])
  expect(first.rows.map((row) => row.summary.task.id)).toEqual(['0'])
  expect(first.rows[0]?.summary.dimensionMatch).toBe('unresolved')
  expect(first.rows[0]?.summary.metrics.tokens.hasKnown).toBe(false)
  expect(first.rows[0]?.summary.metrics.cost.knownAmount).toBeNull()
  expect(first.partial).toBe(true)
  expect(first.nextCursor).not.toBeNull()
  const second = await readDimensionTasks({
    ...input,
    query: { ...query, after: first.nextCursor! },
  })
  expect(second.rows.map((row) => row.summary.task.id)).toEqual(['1'])
  expect(second.nextCursor).toBeNull()
})

test('one remaining source record cannot create a half-read subtotal or prevent later dimension progress', async () => {
  const f = fixture(3),
    query = { ...f.query, selection: JSON.stringify({ purpose: 'task' }), limit: 20 },
    record = {} as UsageLedgerRecord,
    limits: number[] = []
  f.sources.local.records = async (_task, request) => {
    limits.push(request.limit)
    return { items: Array.from({ length: request.limit }, () => record), nextCursor: 'more' }
  }
  const input = {
    ...f,
    query,
    unresolved: unresolvedTask,
    summarize: async (sources: ObservationSnapshotSources, task: ObservationTaskFacts) => {
      if (task.id === '0') await sources.local.records(task.id, { limit: 19_999 })
      if (task.id === '1') {
        await sources.local.records(task.id, { limit: 2 })
        await sources.local.records(task.id, { limit: 1, after: 'more' })
      }
      return f.summarize(sources, task)
    },
  }
  const first = await readDimensionTasks(input)
  expect(limits).toEqual([19_999, 1])
  expect(first.rows.map((row) => row.summary.task.id)).toEqual(['0', '1'])
  expect(first.rows[1]?.summary.dimensionMatch).toBe('unresolved')
  expect(first.rows[1]?.summary.metrics.tokens.hasKnown).toBe(false)
  const second = await readDimensionTasks({
    ...input,
    query: { ...query, after: first.nextCursor! },
  })
  expect(second.rows.map((row) => row.summary.task.id)).toEqual(['2'])
  expect(second.nextCursor).toBeNull()
})

test('dimension projection rejects missing owner positions and preserves partial numeric state at true EOF', async () => {
  const f = fixture(1),
    query = { ...f.query, selection: JSON.stringify({ purpose: 'task' }), limit: 20 },
    list = f.sources.tasks.list
  f.sources.tasks.list = async (input) => ({ ...(await list(input)), positions: [] })
  await expect(readDimensionTasks({ ...f, query, unresolved: unresolvedTask })).rejects.toThrow(
    'positions missing',
  )
  f.sources.tasks.list = list
  const result = await readDimensionTasks({
    ...f,
    query,
    unresolved: unresolvedTask,
    summarize: async (sources, task) => {
      await sources.invocations(task.id)
      return f.summarize(sources, task)
    },
  })
  expect(result.nextCursor).toBeNull()
  // An unknown row can be the actual last task without implying known zero or a fabricated next page.
  f.sources.invocations = async () => ({
    items: Array.from({ length: 10_001 }, () => ({}) as AcceptedObservationInvocation),
    truncated: false,
  })
  const partial = await readDimensionTasks({
    ...f,
    query,
    unresolved: unresolvedTask,
    summarize: async (sources, task) => {
      await sources.invocations(task.id)
      return f.summarize(sources, task)
    },
  })
  expect(partial.nextCursor).toBeNull()
  expect(partial.partial).toBe(true)
  expect(partial.rows[0]?.summary.metrics.tokens.hasKnown).toBe(false)
})

// Controlled source ports exercise the actual Task loader, not a callback that simulates a subtotal.
// The real SQL authorization/continuations and durable valuations have separate provider tests.
test('actual dimension Task loader handles one capture plus 10000 local and 10000 platform rows without stalling', async () => {
  const f = fixture(2),
    input = { ...f.query, selection: JSON.stringify({ purpose: 'task' }), limit: 20 },
    counts = { input: '1', cacheRead: '0', cacheWrite: '0', output: '0' },
    limits: number[] = []
  const localInvocation = (taskId: string): AcceptedObservationInvocation => ({
    invocationId: 'local-' + taskId,
    taskId,
    nodeRunId: null,
    agentId: null,
    agentRevision: null,
    purpose: 'task',
    acceptedAt: 1,
    priceBookRevision: null,
    nativeCaptureContract: 'opencode-child-steps-v1',
    authority: { kind: 'local', runtime: null },
  })
  f.sources.invocations = async (taskId) => ({
    items:
      taskId === '0'
        ? [
            localInvocation(taskId),
            {
              ...localInvocation(taskId),
              invocationId: 'hosted',
              authority: {
                kind: 'crewstation',
                sourceId: 'installation',
                projectId: 'project',
                taskId: 'platform-task',
                subtaskId: 'part',
                executionResourceId: 'pod',
                executionGeneration: 1,
              },
            },
          ]
        : [localInvocation(taskId)],
    truncated: false,
  })
  f.sources.local.captures = async (ids) =>
    ids.map(
      (invocationId) =>
        ({
          invocationId,
          taskId: invocationId.slice(-1),
          priorRevisionGap: false,
          capture: {
            contract: 'opencode-child-steps-v1',
            nativeSource: 'fixture',
            rootSessionId: 'root',
            state: 'complete',
            baseline: { kind: 'fresh', fingerprint: null },
            snapshotFingerprint: 'scan',
            observedAt: 1,
            scannedSessions: 1,
            scannedSteps: 1,
            issues: [],
            priorRevisions: [],
          },
        }) as Awaited<ReturnType<ObservationSnapshotSources['local']['captures']>>[number],
    )
  f.sources.local.records = async (taskId, request) => {
    const record: UsageLedgerRecord = {
      sourceId: 'local',
      observedRevision: 1,
      contribution: counts,
      complete: true,
      issues: [],
      measurement: {
        schemaVersion: 1,
        invocationId: 'local-' + taskId,
        taskId,
        nodeRunId: null,
        agentId: null,
        recordId: 'record',
        revision: 1,
        occurredAt: 1,
        observedAt: 1,
        model: { provider: 'provider', id: 'actual' },
        adapterVersion: 'fixture',
        reporting: 'delta',
        inclusion: 'self',
        coverage: 'complete',
        validity: 'valid',
        basis: { kind: 'invocation' },
        usage: counts,
      },
    }
    if (taskId === '1') return { items: [record] }
    const start = Number(request.after ?? 0),
      count = Math.min(request.limit, 10_000 - start)
    limits.push(count)
    return {
      items: Array.from({ length: count }, () => record),
      ...(start + count < 10_000 ? { nextCursor: String(start + count) } : {}),
    }
  }
  f.sources.platform.records = async (_binding, request) => {
    // Record values are never evaluated: the shared budget interrupts this task first.
    const count = request.limit,
      start = Number(request.after ?? 0)
    limits.push(count)
    return {
      items: Array.from(
        { length: count },
        () =>
          ({}) as Awaited<
            ReturnType<ObservationSnapshotSources['platform']['records']>
          >['items'][number],
      ),
      nextCursor: String(start + count),
      state: {} as Awaited<ReturnType<ObservationSnapshotSources['platform']['records']>>['state'],
    }
  }
  f.sources.value = async () => ({
    currency: 'CNY',
    availability: 'priced',
    amountDecimal: '0.1',
    priceVersionId: 'frozen',
    completeness: 'complete',
  })
  const queries = createTaskObservationQueries({
    now: () => 1000,
    snapshot: { read: (work) => work(f.sources) },
  })
  const first = await queries.list(actor, input)
  expect(limits.reduce((sum, count) => sum + count, 0)).toBe(19_999)
  expect(limits.at(-1)).toBe(499)
  expect(first.items.map((row) => row.task.id)).toEqual(['0'])
  expect(first.items[0]?.dimensionMatch).toBe('unresolved')
  expect(first.items[0]?.metrics.tokens.hasKnown).toBe(false)
  expect(first.items[0]?.metrics.cost.knownAmount).toBeNull()
  expect(first.nextCursor).not.toBeNull()
  const second = await queries.list(actor, { ...input, after: first.nextCursor! })
  expect(second.items.map((row) => row.task.id)).toEqual(['1'])
  expect(second.items[0]?.metrics.tokens.totalKnown).toBe('1')
  expect(second.items[0]?.metrics.cost.knownAmount).toBe('0.1')
  expect(second.nextCursor).toBeNull()
})
