// RFC-371: the formal span alias must preserve the requested original invocation scope.
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type {
  CompleteObservationReport,
  CompleteObservationReportPage,
} from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { mountObservationRoutes } from '@/modules/run-observability/composition/observationRoutes'
import type { CompleteObservationReportQueries } from '@/modules/run-observability/public/queries'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
})
const report: CompleteObservationReport = {
  state: 'ready',
  header: {
    reportId: 'frozen',
    projectionVersion: 2,
    generation: 'original',
    snapshotId: 'snapshot',
    asOf: 3000,
    sourceRevision: 'source',
    actorScope: 'reader',
    authorizationRevision: '0',
    filters: { from: 0, to: 3000, timezone: 'UTC' },
    taskId: 'task',
  },
  summary: {
    metrics: { state: 'not-applicable' },
    inventory: {
      tasks: '1',
      attempts: '1',
      invocations: '2',
      numericRecords: '0',
      nativeCaptures: '0',
    },
    statuses: {},
    timing: { p50Ms: null, p95Ms: null, wallMs: '1000', runningMs: '1000', unknown: '0' },
    rootTask: null,
  },
  counts: { 'span-facts': '2', 'span-statuses': '1', invocations: '2' },
}

function fixture() {
  const reads: { section: string; parent?: string; after?: string; limit: number }[] = []
  const queries: CompleteObservationReportQueries = {
    request: async () => report,
    status: async () => report,
    async page<T>(_actor, reportId, query): Promise<CompleteObservationReportPage<T>> {
      const page = query as (typeof reads)[number]
      reads.push(page)
      const attempt = JSON.stringify(['attempt', 'run']),
        invocation = JSON.stringify(['invocation', 'run', 'call-a'])
      const items: unknown[] =
        page.section === 'span-statuses' && page.parent === attempt
          ? [{ nodeRunId: 'run', state: 'complete' }]
          : page.section === 'invocations' && page.parent === invocation
            ? [{ nodeRunId: 'run', invocationId: 'call-a' }]
            : page.section === 'span-facts' && page.parent === invocation
              ? [{ fact: { invocationId: 'call-a', spanKey: page.after ? 'last' : 'first' } }]
              : page.section === 'span-facts' && page.parent === attempt
                ? [{ fact: { invocationId: 'call-a' } }, { fact: { invocationId: 'call-b' } }]
                : []
      return {
        reportId,
        section: page.section as CompleteObservationReportPage<T>['section'],
        parent: page.parent ?? null,
        items: items as T[],
        total: String(items.length),
        nextCursor:
          page.section === 'span-facts' && page.parent === invocation && !page.after
            ? 'actual-next'
            : null,
      }
    },
  }
  const unavailable = async (): Promise<never> => {
    throw new Error('Legacy capped path used')
  }
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  mountObservationRoutes(app, {
    reports: queries,
    commands: { save: unavailable },
    queries: { runtimes: unavailable, history: unavailable, priceAtAcceptance: unavailable },
    tasks: { overview: unavailable, list: unavailable, detail: unavailable, spans: unavailable },
  })
  return { app, reads }
}

test('invocation-specific formal alias reads its frozen parent and forwards the real continuation', async () => {
  const { app, reads } = fixture()
  for (const after of [null, 'actual-next']) {
    const response = await app.request(
      '/api/observability/tasks/task/spans?nodeRunId=run&invocationId=call-a&reportId=frozen&limit=1' +
        (after ? '&after=' + after : ''),
    )
    expect(response.status).toBe(200)
    const page = (await response.json()) as CompleteObservationReportPage<{
      fact: { invocationId: string; spanKey: string }
    }>
    expect(page.items).toEqual([
      { fact: { invocationId: 'call-a', spanKey: after ? 'last' : 'first' } },
    ])
    expect(page.parent).toBe(JSON.stringify(['invocation', 'run', 'call-a']))
    expect(page.nextCursor).toBe(after ? null : 'actual-next')
  }
  expect(reads.filter((row) => row.section === 'span-facts')).toEqual([
    { section: 'span-facts', parent: JSON.stringify(['invocation', 'run', 'call-a']), limit: 1 },
    {
      section: 'span-facts',
      parent: JSON.stringify(['invocation', 'run', 'call-a']),
      after: 'actual-next',
      limit: 1,
    },
  ])
})

test('unknown attempt or invocation returns not-found without broadening to all attempt spans', async () => {
  const { app, reads } = fixture()
  for (const query of ['nodeRunId=missing', 'nodeRunId=run&invocationId=missing'])
    expect(
      (await app.request('/api/observability/tasks/task/spans?reportId=frozen&' + query)).status,
    ).toBe(404)
  expect(reads.some((row) => row.section === 'span-facts')).toBe(false)
  expect(
    (await app.request('/api/observability/tasks/other/spans?reportId=frozen&nodeRunId=run'))
      .status,
  ).toBe(422)
})

test('without an invocation selector the formal alias retains the complete attempt scope', async () => {
  const { app } = fixture()
  const response = await app.request(
    '/api/observability/tasks/task/spans?reportId=frozen&nodeRunId=run',
  )
  expect(response.status).toBe(200)
  const page = (await response.json()) as CompleteObservationReportPage<{
    fact: { invocationId: string }
  }>
  expect(page.parent).toBe(JSON.stringify(['attempt', 'run']))
  expect(page.items.map((row) => row.fact.invocationId)).toEqual(['call-a', 'call-b'])
})
