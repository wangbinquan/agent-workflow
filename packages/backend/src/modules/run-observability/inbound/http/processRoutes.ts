// RFC-616 §8.1 — HTTP surface of process metrics. Same gate as run observation:
// `tasks:read`, tokens allowed; what a caller may see is narrowed in the use
// cases by its `tasks:read:all` / `tasks:read:own` scope.

import type { Context, Hono } from 'hono'
import type { z } from 'zod'
import {
  PROCESS_NO_SUBJECT,
  ProcessInsightQuerySchema,
  ProcessSubjectKindSchema,
  ProcessSubjectsQuerySchema,
  ProcessSummaryQuerySchema,
  ProcessUnitsQuerySchema,
  type ProcessSubjectKind,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { registerRoute } from '@/routes/registry'
import type { InsightAnalyses } from '../../application/process/insightAnalyses'
import type { ProcessQueries } from '../../application/process/processQueries'

export interface ProcessRouteDependencies {
  readonly queries: ProcessQueries
  readonly insights: InsightAnalyses
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new ValidationError(
      'invalid-query',
      'Invalid process metrics query',
      parsed.error.flatten(),
    )
  return parsed.data
}

function kindOf(c: Context): ProcessSubjectKind {
  return parse(ProcessSubjectKindSchema, c.req.param('kind'))
}

/** `-` stands for units that have no source id. */
function subjectOf(c: Context): string | null {
  const value = c.req.param('subjectId')
  return value === undefined || value === PROCESS_NO_SUBJECT ? null : value
}

export function mountProcessRoutes(app: Hono, deps: ProcessRouteDependencies): void {
  const gate = { permissions: ['tasks:read'] as const, tokenAccess: 'allow' as const }
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/process/subjects',
      summary: 'Workflows, workgroups or digital employees with their process metrics in a window',
    },
    async (c) =>
      c.json(
        await deps.queries.subjects(actorOf(c), parse(ProcessSubjectsQuerySchema, c.req.query())),
      ),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/process/subjects/:kind/:subjectId',
      summary: 'Process metrics of one workflow, workgroup or digital employee in a window',
    },
    async (c) =>
      c.json(
        await deps.queries.summary(
          actorOf(c),
          kindOf(c),
          subjectOf(c),
          parse(ProcessSummaryQuerySchema, c.req.query()),
        ),
      ),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/process/subjects/:kind/:subjectId/units',
      summary: 'Tasks or cases of one subject in a window with their process metrics, paged',
    },
    async (c) =>
      c.json(
        await deps.queries.units(
          actorOf(c),
          kindOf(c),
          subjectOf(c),
          parse(ProcessUnitsQuerySchema, c.req.query()),
        ),
      ),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/process/units/:kind/:unitId',
      summary: 'Stage-by-stage process metrics of one visible task or case',
    },
    async (c) => {
      const detail = await deps.queries.unit(actorOf(c), kindOf(c), c.req.param('unitId'))
      if (!detail) throw new NotFoundError('unit-not-found', 'Unit not found')
      return c.json(detail)
    },
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'GET',
      path: '/api/observability/process/subjects/:kind/:subjectId/insight',
      summary: "Newest text-theme analysis of one subject within the caller's scope",
    },
    async (c) =>
      c.json(
        await deps.insights.view(
          actorOf(c),
          kindOf(c),
          subjectOf(c),
          parse(ProcessInsightQuerySchema, c.req.query()),
        ),
      ),
  )
  registerRoute(
    app,
    {
      ...gate,
      method: 'POST',
      path: '/api/observability/process/subjects/:kind/:subjectId/insight',
      summary: "Queue a text-theme analysis of one subject within the caller's scope",
    },
    async (c) =>
      c.json(
        await deps.insights.request(
          actorOf(c),
          kindOf(c),
          subjectOf(c),
          parse(ProcessInsightQuerySchema, await c.req.json().catch(() => null)),
        ),
        202,
      ),
  )
}
