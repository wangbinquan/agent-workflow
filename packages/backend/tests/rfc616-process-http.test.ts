// RFC-616 §8.1 — the HTTP surface of process metrics.
//
// Six routes under /api/observability/process. Locks: the gate (task read
// permission, tokens allowed), validation at the edge (window, kind, compare
// and split, cursor, the POST body), the `-` path segment for units without a
// source id, 404 for a unit the caller cannot see, and 202 for a queued
// analysis.
import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { PROCESS_NO_SUBJECT } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { InsightAnalyses } from '@/modules/run-observability/application/process/insightAnalyses'
import type { ProcessQueries } from '@/modules/run-observability/application/process/processQueries'
import { mountProcessRoutes } from '@/modules/run-observability/inbound/http/processRoutes'
import { errorHandler, ValidationError } from '@/platform/errors/domainErrors'
import { allOperationRoutes } from '@/platform/operations/catalog'
import { person } from './helpers/processMetricsFakes'

const DAY = 86_400_000
const window = `from=${DAY}&to=${8 * DAY}`
const BASE = '/api/observability/process'

interface Seen {
  readonly method: string
  readonly args: readonly unknown[]
}

function appFor(
  actor: Actor,
  overrides: { queries?: Partial<ProcessQueries>; insights?: Partial<InsightAnalyses> } = {},
) {
  const seen: Seen[] = []
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]) => {
      // The actor is the first argument of every use case; the rest is what the route decoded.
      seen.push({ method, args: args.slice(1) })
      return result
    }
  const queries = {
    subjects: record('subjects', { items: [] }),
    summary: record('summary', { kind: 'workflow' }),
    units: record('units', { items: [], nextCursor: null }),
    unit: record('unit', null),
    ...overrides.queries,
  } as unknown as ProcessQueries
  const insights = {
    view: record('view', { result: null }),
    request: record('request', { id: 'a1', status: 'pending' }),
    ...overrides.insights,
  } as unknown as InsightAnalyses
  const app = new Hono()
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', inject)
  app.onError(errorHandler)
  mountProcessRoutes(app, { queries, insights })
  return { app, seen }
}

const member = person('alice', 'user')
const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('RFC-616 process metrics routes', () => {
  test('the listing takes a kind and a window', async () => {
    const { app, seen } = appFor(member)
    const response = await app.request(`${BASE}/subjects?kind=workgroup&${window}`)
    expect(response.status).toBe(200)
    expect(seen).toEqual([
      { method: 'subjects', args: [{ kind: 'workgroup', from: DAY, to: 8 * DAY }] },
    ])
  })

  test('a summary decodes the kind, the subject, the comparison and the origin filter', async () => {
    const { app, seen } = appFor(member)
    expect((await app.request(`${BASE}/subjects/workflow/wf-1?${window}`)).status).toBe(200)
    expect(
      (
        await app.request(
          `${BASE}/subjects/digital-employee/emp-1?${window}&tzOffset=480&compare=version&split=3&origin=scheduled`,
        )
      ).status,
    ).toBe(200)
    expect(seen).toEqual([
      {
        method: 'summary',
        args: ['workflow', 'wf-1', { from: DAY, to: 8 * DAY, tzOffset: 0, compare: 'off' }],
      },
      {
        method: 'summary',
        args: [
          'digital-employee',
          'emp-1',
          {
            from: DAY,
            to: 8 * DAY,
            tzOffset: 480,
            compare: 'version',
            split: 3,
            origin: 'scheduled',
          },
        ],
      },
    ])
  })

  test('`-` stands for units without a source id on every subject route', async () => {
    const { app, seen } = appFor(member)
    const subject = `${BASE}/subjects/workflow/${PROCESS_NO_SUBJECT}`
    await app.request(`${subject}?${window}`)
    await app.request(`${subject}/units?${window}`)
    await app.request(`${subject}/insight?${window}`)
    await post(app, `${subject}/insight`, { from: DAY, to: 8 * DAY })
    expect(seen.map((entry) => [entry.method, entry.args[1]])).toEqual([
      ['summary', null],
      ['units', null],
      ['view', null],
      ['request', null],
    ])
  })

  test('units are filtered by outcome and origin and paged by cursor', async () => {
    const { app, seen } = appFor(member)
    const response = await app.request(
      `${BASE}/subjects/workgroup/wg-1/units?${window}&status=unsuccessful&origin=api&cursor=abc`,
    )
    expect(response.status).toBe(200)
    expect(seen).toEqual([
      {
        method: 'units',
        args: [
          'workgroup',
          'wg-1',
          { from: DAY, to: 8 * DAY, status: 'unsuccessful', origin: 'api', cursor: 'abc' },
        ],
      },
    ])
    expect((await app.request(`${BASE}/subjects/workgroup/wg-1/units?${window}`)).status).toBe(200)
    expect(seen[1]!.args[2]).toEqual({ from: DAY, to: 8 * DAY, status: 'all' })
  })

  test('invalid windows, kinds, comparisons and filters are rejected before any work', async () => {
    const { app, seen } = appFor(member)
    for (const path of [
      `${BASE}/subjects?${window}`,
      `${BASE}/subjects?kind=agent&${window}`,
      `${BASE}/subjects?kind=workflow`,
      `${BASE}/subjects?kind=workflow&from=${2 * DAY}&to=${DAY}`,
      `${BASE}/subjects?kind=workflow&from=0&to=${367 * DAY}`,
      `${BASE}/subjects/agent/a-1?${window}`,
      `${BASE}/subjects/workflow/wf-1?${window}&compare=yearly`,
      // Splitting at a revision needs the revision.
      `${BASE}/subjects/workflow/wf-1?${window}&compare=version`,
      `${BASE}/subjects/workflow/wf-1?${window}&tzOffset=900`,
      `${BASE}/subjects/workflow/wf-1?${window}&origin=somewhere`,
      `${BASE}/subjects/workflow/wf-1/units?${window}&status=failed`,
      `${BASE}/subjects/workflow/wf-1/units?${window}&cursor=${'x'.repeat(201)}`,
      `${BASE}/subjects/workflow/wf-1/insight`,
      `${BASE}/units/agent/t-1`,
    ]) {
      const response = await app.request(path)
      expect([path, response.status]).toEqual([path, 422])
      expect(await response.json()).toMatchObject({ code: 'invalid-query' })
    }
    expect(seen).toEqual([])
  })

  test('a validation error raised by the use case keeps its status', async () => {
    const { app } = appFor(member, {
      queries: {
        summary: async () => {
          throw new ValidationError('invalid-query', 'A workgroup has no revisions to split at')
        },
      },
    })
    const response = await app.request(
      `${BASE}/subjects/workgroup/wg-1?${window}&compare=version&split=2`,
    )
    expect(response.status).toBe(422)
  })

  test('a unit the caller cannot see is 404; a visible one is returned', async () => {
    const hidden = appFor(member)
    const missing = await hidden.app.request(`${BASE}/units/workflow/t-9`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'unit-not-found' })
    expect(hidden.seen).toEqual([{ method: 'unit', args: ['workflow', 't-9'] }])

    const visible = appFor(member, {
      queries: {
        unit: async () =>
          ({ asOf: 1, unit: { unitId: 't-1' }, stages: [], identities: [] }) as never,
      },
    })
    const found = await visible.app.request(`${BASE}/units/digital-employee/t-1`)
    expect(found.status).toBe(200)
    expect(await found.json()).toMatchObject({ unit: { unitId: 't-1' } })
  })

  test('reading an analysis is a GET with a window; asking for one is a POST answered with 202', async () => {
    const { app, seen } = appFor(member)
    const view = await app.request(`${BASE}/subjects/workflow/wf-1/insight?${window}`)
    expect(view.status).toBe(200)
    const accepted = await post(app, `${BASE}/subjects/workflow/wf-1/insight`, {
      from: DAY,
      to: 8 * DAY,
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ id: 'a1', status: 'pending' })
    expect(seen).toEqual([
      { method: 'view', args: ['workflow', 'wf-1', { from: DAY, to: 8 * DAY }] },
      { method: 'request', args: ['workflow', 'wf-1', { from: DAY, to: 8 * DAY }] },
    ])
  })

  test('a POST without a readable window queues nothing', async () => {
    const { app, seen } = appFor(member)
    for (const body of ['', 'not json', '{}', JSON.stringify({ from: 5, to: 5 })]) {
      const response = await post(app, `${BASE}/subjects/workflow/wf-1/insight`, body)
      expect([body, response.status]).toEqual([body, 422])
    }
    expect(seen).toEqual([])
  })

  test('every route needs the task read permission', async () => {
    const outsider = person('ghost', 'user', [])
    const { app, seen } = appFor(outsider)
    for (const path of [
      `${BASE}/subjects?kind=workflow&${window}`,
      `${BASE}/subjects/workflow/wf-1?${window}`,
      `${BASE}/subjects/workflow/wf-1/units?${window}`,
      `${BASE}/units/workflow/t-1`,
      `${BASE}/subjects/workflow/wf-1/insight?${window}`,
    ])
      expect([path, (await app.request(path)).status]).toEqual([path, 403])
    expect(
      (await post(app, `${BASE}/subjects/workflow/wf-1/insight`, { from: DAY, to: 8 * DAY }))
        .status,
    ).toBe(403)
    expect(seen).toEqual([])
  })

  test('the six routes are declared with the task read gate and are open to tokens', () => {
    appFor(member)
    for (const [method, path] of [
      ['GET', `${BASE}/subjects`],
      ['GET', `${BASE}/subjects/:kind/:subjectId`],
      ['GET', `${BASE}/subjects/:kind/:subjectId/units`],
      ['GET', `${BASE}/units/:kind/:unitId`],
      ['GET', `${BASE}/subjects/:kind/:subjectId/insight`],
      ['POST', `${BASE}/subjects/:kind/:subjectId/insight`],
    ] as const) {
      const route = allOperationRoutes().find(
        (candidate) => candidate.method === method && candidate.path === path,
      )
      expect([path, route?.permissions, route?.tokenAccess]).toEqual([
        path,
        ['tasks:read'],
        'allow',
      ])
    }
  })
})
