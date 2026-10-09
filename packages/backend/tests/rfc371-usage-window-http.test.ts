// AW-R06: unsupported aliases cannot silently return lifecycle totals for an occurrence-time query.
import { expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { mountObservationRoutes } from '@/modules/run-observability/composition/observationRoutes'

test('legacy aliases and Task detail reject unsupported usage windows without reading lifecycle numbers', async () => {
  let called = 0
  const unavailable = async (): Promise<never> => {
    called++
    throw new Error('Lifecycle query must not run for an unsupported usage window')
  }
  const actor = buildActor({
    source: 'session',
    user: {
      id: 'usage-reader',
      username: 'usage-reader',
      displayName: 'Usage reader',
      role: 'admin',
      status: 'active',
    },
  })
  const inject: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  for (const complete of [false, true]) {
    const app = new Hono()
    app.use('*', inject)
    app.onError(errorHandler)
    mountObservationRoutes(app, {
      commands: { save: unavailable },
      queries: { runtimes: unavailable, history: unavailable, priceAtAcceptance: unavailable },
      tasks: { overview: unavailable, list: unavailable, detail: unavailable },
      ...(complete
        ? { reports: { request: unavailable, status: unavailable, page: unavailable } }
        : {}),
    })
    const paths = complete
      ? ['/api/observability/tasks/original-task']
      : [
          '/api/observability/overview',
          '/api/observability/tasks',
          '/api/observability/tasks/original-task',
        ]
    for (const path of paths) {
      const response = await app.request(path + '?from=100&to=200&timezone=UTC&cohort=usage')
      expect(response.status).toBe(422)
      expect(await response.text()).toContain(
        path.endsWith('/original-task')
          ? 'Task details show lifecycle usage'
          : 'Usage windows require complete reports',
      )
    }
  }
  expect(called).toBe(0)
})
