import type { Hono } from 'hono'
import {
  ObservationMaintenanceRequestSchema,
  ObservationMaintenanceConfirmSchema,
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
  if (reports.storage)
    registerRoute(
      app,
      {
        permissions: ['settings:write'],
        tokenAccess: 'allow',
        method: 'GET',
        path: '/api/observability/storage',
        summary: 'Read observed capacity and durable projection backlog',
      },
      async (c) => c.json(await reports.storage!()),
    )
  if (reports.compare)
    registerRoute(
      app,
      {
        ...gate,
        method: 'GET',
        path: '/api/observability/reports/:id/comparison',
        summary: 'Compare two visible execution subtrees at the same original projection version',
      },
      async (c) => {
        const { left, right } = c.req.query()
        if (!left || !right || left.length > 512 || right.length > 512)
          throw new ValidationError('invalid-query', 'Select two original Tasks')
        return c.json(
          await completeObservationHttpRead(() =>
            reports.compare!(actorOf(c), c.req.param('id'), left, right),
          ),
        )
      },
    )

  if (reports.maintenance) {
    const maintenance = reports.maintenance,
      admin = { permissions: ['settings:write'] as const, tokenAccess: 'allow' as const }
    registerRoute(
      app,
      {
        ...admin,
        method: 'POST',
        path: '/api/observability/maintenance',
        summary: 'Prepare an explicit frozen observation maintenance preview',
      },
      async (c) => {
        const request = ObservationMaintenanceRequestSchema.safeParse(
          await c.req.json().catch(() => null),
        )
        if (!request.success)
          throw new ValidationError('invalid-query', 'Invalid maintenance request')
        return c.json(
          await completeObservationHttpRead(() => maintenance.prepare(actorOf(c), request.data)),
          202,
        )
      },
    )
    registerRoute(
      app,
      {
        ...admin,
        method: 'GET',
        path: '/api/observability/maintenance/:id',
        summary: 'Read durable observation maintenance progress',
      },
      async (c) =>
        c.json(
          await completeObservationHttpRead(() =>
            maintenance.status(actorOf(c), c.req.param('id')),
          ),
        ),
    )
    registerRoute(
      app,
      {
        ...admin,
        method: 'POST',
        path: '/api/observability/maintenance/:id/confirm',
        summary: 'Confirm an exact observation maintenance preview',
      },
      async (c) => {
        const request = ObservationMaintenanceConfirmSchema.safeParse(
          await c.req.json().catch(() => null),
        )
        if (!request.success)
          throw new ValidationError('invalid-query', 'Invalid maintenance confirmation')
        return c.json(
          await completeObservationHttpRead(() =>
            maintenance.confirm(actorOf(c), c.req.param('id'), request.data),
          ),
        )
      },
    )
  }

  if (reports.anomalies)
    registerRoute(
      app,
      {
        ...gate,
        method: 'GET',
        path: '/api/observability/anomalies',
        summary: 'Read authorized durable anomaly lifecycle records',
      },
      async (c) => {
        const raw = c.req.query(),
          from = Number(raw.from),
          to = Number(raw.to),
          pageSize = raw.pageSize === undefined ? 200 : Number(raw.pageSize)
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          from < 0 ||
          from >= to ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 200
        )
          throw new ValidationError('invalid-query', 'Invalid anomaly window/page')
        return c.json(
          await reports.anomalies!(actorOf(c), {
            from,
            to,
            pageSize,
            ...(raw.after ? { after: raw.after } : {}),
          }),
        )
      },
    )
  if (reports.projectionVersion)
    registerRoute(
      app,
      {
        ...gate,
        method: 'GET',
        path: '/api/observability/projection-version',
        summary: 'Read the committed observation projection version without recalculation',
      },
      async (c) => c.json(await reports.projectionVersion!()),
    )
  registerRoute(
    app,
    {
      ...gate,
      method: 'POST',
      path: '/api/observability/reports',
      executionGroup: 'observation',
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
