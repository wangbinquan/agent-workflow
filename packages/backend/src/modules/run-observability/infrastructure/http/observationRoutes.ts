import type { Hono } from 'hono'
import {
  ObservationOverviewQuerySchema,
  ObservationSnapshotExportQuerySchema,
  ObservationPricePageQuerySchema,
  ObservationTaskPageQuerySchema,
  SaveObservationPriceSchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { ObservationPriceError } from '../../domain/priceError'
import { exportObservationSnapshot } from '../../application/observationExport'
import type { ObservationPricingCommands } from '../../ports/pricingCommands'
import type { ObservationPricingQueries } from '../../ports/pricingQueries'
import type { ObservationTaskQueries } from '../../public/queries'

export interface ObservationRouteDependencies {
  readonly commands: ObservationPricingCommands
  readonly queries: ObservationPricingQueries
  readonly tasks: ObservationTaskQueries
}
async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof ObservationPriceError)) throw error
    const status =
      error.code === 'runtime-not-found' ? 404 : error.code === 'invalid-price' ? 422 : 409
    throw new DomainError(error.code, error.message, status, error.details)
  }
}
export function mountObservationRoutes(app: Hono, deps: ObservationRouteDependencies): void {
  const readGate = { permissions: ['tasks:read'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...readGate,
      method: 'POST',
      path: '/api/observability/exports/snapshot',
      summary: 'Export a fresh visible bounded task or agent snapshot as CNY CSV',
    },
    async (c) => {
      const query = ObservationSnapshotExportQuerySchema.safeParse(
        await c.req.json().catch(() => null),
      )
      if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation export')
      const snapshot = await deps.tasks.overview(actorOf(c), query.data.window)
      return c.json(exportObservationSnapshot(snapshot, query.data))
    },
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/overview',
      summary: 'Read visible task cohort totals, trends and agent/model/runtime distributions',
    },
    async (c) => {
      const query = ObservationOverviewQuerySchema.safeParse(c.req.query())
      if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation window')
      return c.json(await deps.tasks.overview(actorOf(c), query.data))
    },
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/tasks',
      summary: 'Read visible task lifecycle observation summaries',
    },
    async (c) => {
      const query = ObservationTaskPageQuerySchema.safeParse(c.req.query())
      if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation query')
      try {
        return c.json(await deps.tasks.list(actorOf(c), query.data))
      } catch (error) {
        if (error instanceof RangeError) throw new ValidationError('invalid-query', error.message)
        throw error
      }
    },
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/tasks/:id',
      summary: 'Read task, agent and attempt observations in one snapshot',
    },
    async (c) => {
      const result = await deps.tasks.detail(actorOf(c), c.req.param('id'))
      if (!result) throw new NotFoundError('task-not-found', 'Task not found')
      return c.json(result)
    },
  )
  const gate = { permissions: ['settings:write'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/pricing/runtimes',
      summary: 'List runtime CNY pricing metadata',
    },
    async (c) => c.json(await mapped(() => deps.queries.runtimes())),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/pricing/runtimes/:registrationId/versions',
      summary: 'Read immutable CNY price history',
    },
    async (c) => {
      const parsed = ObservationPricePageQuerySchema.safeParse(c.req.query())
      if (!parsed.success)
        throw new ValidationError('invalid-query', 'Invalid price history cursor or page size')
      return c.json(
        await mapped(() => deps.queries.history(c.req.param('registrationId'), parsed.data)),
      )
    },
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'POST',
      path: '/api/observability/pricing/runtimes/:registrationId/versions',
      summary: 'Append an independently saved CNY price version',
    },
    async (c) => {
      const parsed = SaveObservationPriceSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        throw new ValidationError(
          'invalid-price',
          'Invalid CNY price version',
          parsed.error.flatten(),
        )
      return c.json(
        await mapped(() =>
          deps.commands.save(c.req.param('registrationId'), parsed.data, actorOf(c).user.id),
        ),
        201,
      )
    },
  )
}
