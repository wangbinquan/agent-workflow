// RFC-371 v2 §5 (design/RFC-371-run-observability/redesign-v2-20261014.md):
// the HTTP surface — statistics need task read permission, prices need
// settings write; windows, cursors and price bodies are validated at the edge;
// a missing task is 404, an unknown runtime 404 and a stale price line 409.
import { expect, test } from 'bun:test'
import { Hono, type Context } from 'hono'
import { buildActor, type Actor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { ObservationPriceError } from '@/modules/run-observability/application/pricing'
import type { ObservationPricing } from '@/modules/run-observability/application/pricing'
import type { ObservationQueries } from '@/modules/run-observability/application/observationQueries'
import { mountObservationRoutes } from '@/modules/run-observability/inbound/http/observationRoutes'

const DAY = 86_400_000

function person(role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id: `u-${role}`, username: role, displayName: role, role, status: 'active' },
    source: 'session',
  })
}

function appFor(
  actor: Actor,
  overrides: { queries?: Partial<ObservationQueries>; pricing?: Partial<ObservationPricing> } = {},
) {
  const seen: { readonly method: string; readonly args: unknown[] }[] = []
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]) => {
      seen.push({ method, args })
      return result
    }
  const queries = {
    overview: record('overview', { asOf: 1 }),
    tasks: record('tasks', { asOf: 1, items: [], nextCursor: null }),
    task: record('task', null),
    agents: record('agents', { asOf: 1, partial: false, truncated: false, items: [] }),
    models: record('models', { asOf: 1, partial: false, truncated: false, items: [] }),
    system: record('system', { asOf: 1, partial: false, kinds: [], recent: [], nextCursor: null }),
    ...overrides.queries,
  } as unknown as ObservationQueries
  const pricing = {
    directory: record('directory', { runtimes: [] }),
    history: record('history', { items: [] }),
    save: record('save', { id: 'p1' }),
    ...overrides.pricing,
  } as unknown as ObservationPricing
  const app = new Hono()
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  mountObservationRoutes(app, { queries, pricing })
  return { app, seen }
}

const window = `from=${DAY}&to=${8 * DAY}`
const price = {
  model: 'sonnet',
  rates: { input: '3', cacheRead: '0.3', cacheWrite: null, output: '15' },
  effectiveFrom: 0,
  note: '',
  expectedLatestId: null,
}
const post = (app: Hono, body: unknown, runtime = 'rt-1') =>
  app.request(`/api/observability/pricing/${runtime}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a member reads statistics with a validated window', async () => {
  const { app, seen } = appFor(person('user'))
  const res = await app.request(`/api/observability/overview?${window}&tzOffset=480`)
  expect(res.status).toBe(200)
  expect(seen).toEqual([
    {
      method: 'overview',
      args: [expect.anything(), { from: DAY, to: 8 * DAY, tzOffset: 480 }],
    },
  ])
  for (const path of ['tasks', 'agents', 'models', 'system'])
    expect((await app.request(`/api/observability/${path}?${window}`)).status).toBe(200)
  expect(seen.find((entry) => entry.method === 'agents')?.args[1]).toEqual({
    from: DAY,
    to: 8 * DAY,
    tzOffset: 0,
  })
})

test('windows that are empty, reversed or longer than 366 days are rejected', async () => {
  const { app, seen } = appFor(person('user'))
  for (const query of [
    '',
    `from=${DAY}&to=${DAY}`,
    `from=${2 * DAY}&to=${DAY}`,
    `from=0&to=${367 * DAY}`,
    `${window}&tzOffset=900`,
    `from=abc&to=${DAY}`,
  ]) {
    const res = await app.request(`/api/observability/overview?${query}`)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'invalid-query' })
  }
  expect(seen).toEqual([])
})

test('a malformed cursor is a validation error, a missing task is 404', async () => {
  const invalid = async () => {
    throw new RangeError('invalid-cursor')
  }
  const { app } = appFor(person('user'), { queries: { tasks: invalid, system: invalid } })
  for (const path of ['tasks', 'system']) {
    const res = await app.request(`/api/observability/${path}?${window}&cursor=broken`)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'invalid-query' })
  }
  const missing = await app.request('/api/observability/tasks/t-missing')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ code: 'task-not-found' })
})

test('an actor without task read permission is refused', async () => {
  const nobody = { ...person('user'), permissions: new Set<string>() } as unknown as Actor
  const { app, seen } = appFor(nobody)
  expect((await app.request(`/api/observability/overview?${window}`)).status).toBe(403)
  expect(seen).toEqual([])
})

test('price lines need settings write; saves validate, map conflicts and record the author', async () => {
  const member = appFor(person('user'))
  expect((await member.app.request('/api/observability/pricing')).status).toBe(403)
  expect((await post(member.app, price)).status).toBe(403)
  expect(member.seen).toEqual([])

  const admin = appFor(person('admin'))
  expect((await admin.app.request('/api/observability/pricing')).status).toBe(200)
  const created = await post(admin.app, price)
  expect(created.status).toBe(201)
  expect(admin.seen.at(-1)).toEqual({ method: 'save', args: ['rt-1', price, 'u-admin'] })

  const history = await admin.app.request('/api/observability/pricing/rt-1/history')
  expect(history.status).toBe(422)
  expect(
    (await admin.app.request('/api/observability/pricing/rt-1/history?model=sonnet')).status,
  ).toBe(200)
  expect(admin.seen.at(-1)).toEqual({ method: 'history', args: ['rt-1', 'sonnet'] })

  for (const body of [
    { ...price, rates: { ...price.rates, input: '-1' } },
    { ...price, rates: { ...price.rates, input: '1.1234567' } },
    { ...price, model: '' },
    { ...price, extra: true },
    'not json',
  ]) {
    const res = await post(admin.app, body)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'invalid-price' })
  }

  for (const [code, status] of [
    ['runtime-not-found', 404],
    ['price-conflict', 409],
  ] as const) {
    const failing = appFor(person('admin'), {
      pricing: {
        save: async () => {
          throw new ObservationPriceError(code, code)
        },
      },
    })
    const res = await post(failing.app, price)
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ code })
  }
})
