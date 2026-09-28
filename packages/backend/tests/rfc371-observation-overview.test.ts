import { expect, test } from 'bun:test'
import type {
  AcceptedObservationInvocation,
  ObservationMetrics,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../src/modules/run-observability/domain/usageLedger'
import { buildActor } from '../src/auth/actor'
import { aggregateObservationMetrics as aggregate } from '../src/modules/run-observability/domain/aggregateMetrics'
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
