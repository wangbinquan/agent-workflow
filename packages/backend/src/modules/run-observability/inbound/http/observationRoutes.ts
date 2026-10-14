// RFC-371 v2 §5 — HTTP surface of run observation.

import type { Hono } from 'hono'
import type { z } from 'zod'
import {
  ObservationSystemQuerySchema,
  ObservationTaskPageQuerySchema,
  ObservationWindowQuerySchema,
  SaveObservationPriceSchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { ObservationQueries } from '../../application/observationQueries'
import { ObservationPriceError, type ObservationPricing } from '../../application/pricing'

export interface ObservationRouteDependencies {
  readonly queries: ObservationQueries
  readonly pricing: ObservationPricing
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new ValidationError('invalid-query', 'Invalid observation query', parsed.error.flatten())
  return parsed.data
}

async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RangeError && error.message === 'invalid-cursor')
      throw new ValidationError('invalid-query', 'Invalid observation cursor')
    throw error
  }
}

export function mountObservationRoutes(app: Hono, deps: ObservationRouteDependencies): void {
  const readGate = { permissions: ['tasks:read'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/overview',
      summary: 'Consumption, task outcomes and daily trend of the visible scope in a window',
    },
    async (c) =>
      c.json(
        await deps.queries.overview(actorOf(c), parse(ObservationWindowQuerySchema, c.req.query())),
      ),
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/tasks',
      summary: 'Visible tasks created in a window with their lifetime consumption',
    },
    async (c) =>
      c.json(
        await read(() =>
          deps.queries.tasks(actorOf(c), parse(ObservationTaskPageQuerySchema, c.req.query())),
        ),
      ),
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/tasks/:id',
      summary: 'Runtime calls, swimlane data and consumption of one visible task',
    },
    async (c) => {
      const detail = await deps.queries.task(actorOf(c), c.req.param('id'))
      if (!detail) throw new NotFoundError('task-not-found', 'Task not found')
      return c.json(detail)
    },
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/agents',
      summary: 'Consumption per agent in a window',
    },
    async (c) =>
      c.json(
        await deps.queries.agents(actorOf(c), parse(ObservationWindowQuerySchema, c.req.query())),
      ),
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/models',
      summary: 'Consumption per runtime and actual model in a window',
    },
    async (c) =>
      c.json(
        await deps.queries.models(actorOf(c), parse(ObservationWindowQuerySchema, c.req.query())),
      ),
  )
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/system',
      summary: 'Platform system-agent work in a window, by kind and newest first',
    },
    async (c) =>
      c.json(
        await read(() =>
          deps.queries.system(actorOf(c), parse(ObservationSystemQuerySchema, c.req.query())),
        ),
      ),
  )

  const priceGate = { permissions: ['settings:write'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...priceGate,
      method: 'GET',
      path: '/api/observability/pricing',
      summary: 'CNY price lines per runtime and actual model',
    },
    async (c) => c.json(await deps.pricing.directory()),
  )
  registerRoute(
    app,
    {
      ...priceGate,
      method: 'GET',
      path: '/api/observability/pricing/:runtimeId/history',
      summary: 'Immutable CNY price versions of one runtime model',
    },
    async (c) => {
      const model = c.req.query('model')
      if (!model) throw new ValidationError('invalid-query', 'model is required')
      return c.json(await deps.pricing.history(c.req.param('runtimeId'), model))
    },
  )
  registerRoute(
    app,
    {
      ...priceGate,
      method: 'POST',
      path: '/api/observability/pricing/:runtimeId',
      summary: 'Append a CNY price version for one runtime model',
    },
    async (c) => {
      const parsed = SaveObservationPriceSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        throw new ValidationError(
          'invalid-price',
          'Invalid CNY price version',
          parsed.error.flatten(),
        )
      try {
        return c.json(
          await deps.pricing.save(c.req.param('runtimeId'), parsed.data, actorOf(c).user.id),
          201,
        )
      } catch (error) {
        if (!(error instanceof ObservationPriceError)) throw error
        throw new DomainError(
          error.code,
          error.message,
          error.code === 'runtime-not-found' ? 404 : 409,
        )
      }
    },
  )
}
