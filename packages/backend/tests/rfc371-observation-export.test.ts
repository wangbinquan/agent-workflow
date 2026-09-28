// RFC-371: CSV preserves exact known values, missing values, stable agent revisions and filters.
import { expect, test } from 'bun:test'
import {
  ObservationSnapshotExportQuerySchema,
  ObservationSnapshotExportSchema,
  type ObservationMetrics,
  type ObservationOverview,
} from '@agent-workflow/shared'
import { exportObservationSnapshot } from '../src/modules/run-observability/application/observationExport'

const window = { from: 0, to: 1000, timezone: 'Asia/Shanghai' }
const metrics: ObservationMetrics = {
  invocations: 1,
  observedInvocations: 1,
  records: 1,
  tokens: {
    known: { input: '90071992547409930001', cacheRead: '0', cacheWrite: '0', output: '0' },
    totalKnown: '90071992547409930001',
    hasKnown: true,
    complete: false,
    unknownBuckets: { input: 0, cacheRead: 0, cacheWrite: 1, output: 0 },
  },
  cost: {
    currency: 'CNY',
    knownAmount: '0.000000000001',
    complete: false,
    pricedRecords: 1,
    priceVersionIds: ['accepted-version'],
    reasons: ['pricing-partial'],
  },
  authorities: ['local'],
  truncated: false,
}
function fixture(): ObservationOverview {
  return {
    asOf: 1500,
    projectionVersion: 1,
    cohort: 'started',
    taskScope: 'direct',
    filtersEcho: window,
    partial: true,
    limits: { tasks: 200, invocations: 10000, records: 20000 },
    metrics,
    tasks: ['first', 'second'].map((id) => ({
      task: {
        id,
        name: `=Hello,"${id}"\n世界`,
        status: 'done',
        parentTaskId: null,
        startedAt: 100,
        finishedAt: 110,
        runningSince: null,
        runningMs: 10,
      },
      metrics:
        id === 'first'
          ? metrics
          : {
              ...metrics,
              tokens: { ...metrics.tokens, hasKnown: false },
              cost: { ...metrics.cost, knownAmount: null },
            },
      wallMs: 10,
      runningMs: 10,
    })),
    agents: [2, 3].map((revision) => ({
      agentId: 'agent',
      agentRevision: revision,
      purpose: 'task',
      metrics: {
        ...metrics,
        tokens: {
          ...metrics.tokens,
          totalKnown: String(revision),
          known: { ...metrics.tokens.known, input: String(revision) },
        },
      },
      tasks: [{ taskId: 'first', metrics }],
    })),
    quality: [{ reason: 'pricing-partial', taskIds: ['first'] }],
    statuses: [],
    trend: [],
    models: [],
    runtimes: [],
    durations: { completedTasks: 2, p50Ms: 10, p95Ms: 10, maxMs: 10 },
  }
}

/** Parse actual CSV, including embedded commas, quotes and newlines. */
function csv(content: string): Record<string, string>[] {
  const lines: string[][] = [],
    row: string[] = []
  let text = '',
    quoted = false
  const input = content.replace(/^\ufeff/, '')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (char === '"' && quoted && input[i + 1] === '"') {
      text += '"'
      i++
    } else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      row.push(text)
      text = ''
    } else if (char === '\r' && input[i + 1] === '\n' && !quoted) {
      row.push(text)
      lines.push(row.splice(0))
      text = ''
      i++
    } else text += char
  }
  const headers = lines.shift()!
  return lines.map((line) => Object.fromEntries(headers.map((key, i) => [key, line[i]!])))
}

test('task CSV round-trips exact pico-CNY, huge tokens, unknown flags and snapshot metadata', () => {
  const result = ObservationSnapshotExportSchema.parse(
    exportObservationSnapshot(fixture(), { window, view: 'tasks' }),
  )
  expect(result).toMatchObject({ rows: 2, partial: true, bounded: true, asOf: 1500 })
  expect(result.filename).toBe('aw-observations-tasks-0-1000.csv')
  expect(result.content.startsWith('\ufeff')).toBe(true)
  const rows = csv(result.content)
  expect(rows[0]).toMatchObject({
    task_id: 'first',
    task_name: '\'=Hello,"first"\n世界',
    tokens_total_known: '90071992547409930001',
    cost_known_cny: '0.000000000001',
    cost_complete: 'false',
    cache_write_unknown: '1',
    currency: 'CNY',
    as_of: '1500',
    timezone: 'Asia/Shanghai',
    task_scope: 'direct',
    cohort: 'started',
    snapshot_partial: 'true',
    task_limit: '200',
    price_versions: '["accepted-version"]',
  })
  expect(rows[1]).toMatchObject({ cost_known_cny: '', tokens_has_known: 'false' })
  const zero = fixture()
  const resultZero = exportObservationSnapshot(
    {
      ...zero,
      tasks: [
        { ...zero.tasks[0]!, metrics: { ...metrics, cost: { ...metrics.cost, knownAmount: '0' } } },
      ],
    },
    { window, view: 'tasks' },
  )
  expect(csv(resultZero.content)[0]?.cost_known_cny).toBe('0')
})

test('quality selection uses the same task IDs and an absent reason yields an empty CSV', () => {
  const query = { window, view: 'tasks' as const, quality: 'pricing-partial' }
  const result = exportObservationSnapshot(fixture(), query)
  expect(csv(result.content).map((row) => row.task_id)).toEqual(['first'])
  expect(csv(result.content)[0]?.quality_filter).toBe('pricing-partial')
  expect(exportObservationSnapshot(fixture(), { ...query, quality: 'missing' }).rows).toBe(0)
})

test('selected agent exports its stable revision and purpose, and never the whole-task total', () => {
  const query = { window, view: 'agents' as const, agent: '["agent",3,"task"]' }
  const result = exportObservationSnapshot(fixture(), query)
  expect(result.rows).toBe(1)
  expect(csv(result.content)[0]).toMatchObject({
    agent_key: query.agent,
    agent_id: 'agent',
    agent_revision: '3',
    purpose: 'task',
    task_ids: '["first"]',
    task_count: '1',
    tokens_total_known: '3',
  })
  expect(exportObservationSnapshot(fixture(), { ...query, agent: '["agent",4,"task"]' }).rows).toBe(
    0,
  )
  expect(exportObservationSnapshot(fixture(), { window, view: 'agents' }).rows).toBe(2)
})

test('export queries reject pagination, invalid windows and contradictory selections', () => {
  for (const input of [
    { window: { ...window, after: 'page' }, view: 'tasks' },
    { window: { ...window, limit: 25 }, view: 'tasks' },
    { window: { ...window, from: 1000 }, view: 'tasks' },
    { window: { ...window, timezone: 'invalid' }, view: 'tasks' },
    { window, view: 'tasks', agent: 'agent' },
    { window, view: 'agents', quality: 'reason' },
  ])
    expect(ObservationSnapshotExportQuerySchema.safeParse(input).success).toBe(false)
  expect(ObservationSnapshotExportQuerySchema.parse({ window, view: 'tasks' })).toEqual({
    window,
    view: 'tasks',
  })
  const selected = {
    ...window,
    q: ' alpha ',
    status: 'done',
    repository: '/repo',
    workflow: 'workflow',
  }
  const parsed = ObservationSnapshotExportQuerySchema.parse({ window: selected, view: 'tasks' })
  expect(parsed.window).toMatchObject({
    q: 'alpha',
    status: 'done',
    repository: '/repo',
    workflow: 'workflow',
  })
  expect(csv(exportObservationSnapshot(fixture(), parsed).content)[0]).toMatchObject({
    task_query: 'alpha',
    status_filter: 'done',
    repository_filter: '/repo',
    workflow_filter: 'workflow',
  })
  expect(
    ObservationSnapshotExportQuerySchema.safeParse({
      window: { ...window, status: 'unknown' },
      view: 'tasks',
    }).success,
  ).toBe(false)
})
