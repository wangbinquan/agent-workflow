import type { Hono } from 'hono'
import {
  ObservationOverviewQuerySchema,
  ObservationPricePageQuerySchema,
  ObservationTaskPageQuerySchema,
  SaveObservationPriceSchema,
  type CompleteObservationInvocation,
  type CompleteObservationTraceStatus,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { ObservationPriceError } from '../../domain/priceError'
import { parseObservationSelection } from '../../domain/analysisDimensions'
import type { ObservationPricingCommands } from '../../ports/pricingCommands'
import type { ObservationPricingQueries } from '../../ports/pricingQueries'
import type { CompleteObservationReportQueries, ObservationTaskQueries } from '../../public/queries'
import {
  completeObservationHttpRead,
  mountCompleteObservationRoutes,
} from './completeObservationRoutes'

export interface ObservationRouteDependencies {
  readonly commands: ObservationPricingCommands
  readonly queries: ObservationPricingQueries
  readonly tasks: ObservationTaskQueries
  readonly reports?: CompleteObservationReportQueries
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
function validateDimensionQuery(query: Readonly<Record<string, string>>): void {
  try {
    parseObservationSelection(query.selection)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new DomainError('invalid-query', error.message, 400)
  }
}
export function mountObservationRoutes(app: Hono, deps: ObservationRouteDependencies): void {
  if (deps.reports) mountCompleteObservationRoutes(app, deps.reports)
  const readGate = { permissions: ['tasks:read'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...readGate,
      method: 'GET',
      path: '/api/observability/tasks/:id/spans',
      summary: 'Read original tool, model and native-agent spans with CNY contribution links',
    },
    async (c) => {
      const raw = c.req.query(),
        limit = raw.limit === undefined ? 200 : Number(raw.limit)
      if (!raw.nodeRunId || !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new ValidationError('invalid-query', 'Invalid span query')
      try {
        if (deps.reports) {
          if (!raw.reportId)
            throw new ValidationError(
              'invalid-query',
              'Read spans from a complete frozen Task report',
            )
          const report = await deps.reports.status(actorOf(c), raw.reportId)
          if (report.state !== 'ready' || report.header.taskId !== c.req.param('id'))
            throw new ValidationError(
              'invalid-query',
              'Complete Task report is not ready or changed scope',
            )
          const attemptParent = JSON.stringify(['attempt', raw.nodeRunId])
          const attempt = await deps.reports.page<CompleteObservationTraceStatus>(
            actorOf(c),
            raw.reportId,
            { section: 'span-statuses', parent: attemptParent, limit: 1 },
          )
          if (!attempt.items.some((row) => row.nodeRunId === raw.nodeRunId))
            throw new NotFoundError(
              'attempt-not-found',
              'Attempt not found in complete Task report',
            )
          const parent = raw.invocationId
            ? JSON.stringify(['invocation', raw.nodeRunId, raw.invocationId])
            : attemptParent
          if (raw.invocationId) {
            const invocation = await deps.reports.page<CompleteObservationInvocation>(
              actorOf(c),
              raw.reportId,
              { section: 'invocations', parent, limit: 1 },
            )
            if (
              !invocation.items.some(
                (row) => row.nodeRunId === raw.nodeRunId && row.invocationId === raw.invocationId,
              )
            )
              throw new NotFoundError(
                'invocation-not-found',
                'Invocation not found in complete Task report attempt',
              )
          }
          return c.json(
            await deps.reports.page(actorOf(c), raw.reportId, {
              section: 'span-facts',
              parent,
              ...(raw.after ? { after: raw.after } : {}),
              limit,
            }),
          )
        }
        const result = await deps.tasks.spans?.(actorOf(c), c.req.param('id'), {
          nodeRunId: raw.nodeRunId,
          ...(raw.invocationId ? { invocationId: raw.invocationId } : {}),
          ...(raw.after ? { after: raw.after } : {}),
          limit,
        })
        if (!result) throw new NotFoundError('task-not-found', 'Task or attempt not found')
        return c.json(result)
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
      path: '/api/observability/overview',
      summary: 'Read visible task cohort totals, trends and agent/model/runtime distributions',
    },
    async (c) => {
      const raw = c.req.query()
      validateDimensionQuery(raw)
      const query = ObservationOverviewQuerySchema.safeParse(raw)
      if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation window')
      if (deps.reports)
        return c.json(
          await completeObservationHttpRead(() =>
            deps.reports!.request(actorOf(c), query.data, 'full-alias'),
          ),
        )
      if (query.data.cohort === 'usage')
        throw new ValidationError('invalid-query', 'Usage windows require complete reports')
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
      const raw = c.req.query()
      validateDimensionQuery(raw)
      if (deps.reports) {
        if (raw.after !== undefined)
          throw new ValidationError('invalid-query', 'Page the immutable complete report instead')
        const { limit: _legacyPageSize, ...filters } = raw
        const query = ObservationOverviewQuerySchema.safeParse(filters)
        if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation window')
        return c.json(
          await completeObservationHttpRead(() =>
            deps.reports!.request(actorOf(c), query.data, 'full-alias'),
          ),
        )
      }
      const query = ObservationTaskPageQuerySchema.safeParse(raw)
      if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation query')
      if (query.data.cohort === 'usage')
        throw new ValidationError('invalid-query', 'Usage windows require complete reports')
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
      if (c.req.query().cohort === 'usage')
        throw new ValidationError('invalid-query', 'Task details show lifecycle usage')
      if (deps.reports) {
        const raw = c.req.query()
        validateDimensionQuery(raw)
        const query = ObservationOverviewQuerySchema.safeParse(raw)
        if (!query.success) throw new ValidationError('invalid-query', 'Invalid observation window')
        return c.json(
          await completeObservationHttpRead(() =>
            deps.reports!.request(actorOf(c), query.data, 'full-alias', c.req.param('id')),
          ),
        )
      }
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
