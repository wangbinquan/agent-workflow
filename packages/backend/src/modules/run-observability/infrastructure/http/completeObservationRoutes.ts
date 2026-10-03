import type { Hono } from 'hono'
import {
  CompleteObservationReportRequestSchema,
  CompleteObservationPageQuerySchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { DomainError, ValidationError } from '@/util/errors'
import { CompleteObservationError } from '../../domain/completeObservationError'
import type { CompleteObservationReportQueries } from '../../public/queries'

export async function completeObservationHttpRead<T>(read: () => Promise<T>) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof RangeError) throw new ValidationError('invalid-query', error.message)
    if (!(error instanceof CompleteObservationError)) throw error
    throw new DomainError(
      error.code,
      error.message,
      error.code === 'not-found' ? 404 : error.code === 'not-ready' ? 425 : 409,
    )
  }
}
export function mountCompleteObservationRoutes(
  app: Hono,
  reports: CompleteObservationReportQueries,
) {
  const gate = { permissions: ['tasks:read'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...gate,
      method: 'POST',
      path: '/api/observability/reports',
      summary: 'Build complete visible original observation report without population caps',
    },
    async (c) => {
      const request = CompleteObservationReportRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!request.success)
        throw new ValidationError('invalid-query', 'Invalid complete observation report request')
      return c.json(
        await completeObservationHttpRead(() =>
          reports.request(
            actorOf(c),
            request.data.filters,
            request.data.refreshKey,
            request.data.taskId,
          ),
        ),
      )
    },
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/reports/:id',
      summary: 'Read full original report build status and immutable totals',
    },
    async (c) =>
      c.json(
        await completeObservationHttpRead(() => reports.status(actorOf(c), c.req.param('id'))),
      ),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/reports/:id/pages',
      summary:
        'Page complete retained output with immutable exact totals and original permission checks',
    },
    async (c) => {
      const query = CompleteObservationPageQuerySchema.safeParse(c.req.query())
      if (!query.success)
        throw new ValidationError('invalid-query', 'Invalid complete observation report page')
      return c.json(
        await completeObservationHttpRead(() =>
          reports.page(actorOf(c), c.req.param('id'), query.data),
        ),
      )
    },
  )
}
