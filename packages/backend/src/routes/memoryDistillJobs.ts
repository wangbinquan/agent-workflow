// RFC-041/RFC-305 — capability-gated monitoring + control of the distill queue.
//
//   GET  /api/memory-distill-jobs[?status=pending|running|done|failed|canceled]
//   POST /api/memory-distill-jobs/:id/retry    failed → pending
//   POST /api/memory-distill-jobs/:id/cancel   pending → canceled
//
// Every endpoint explicitly requires `memory-distill-jobs:manage`; role presets
// are not inspected by this transport or its service consumers.

import { DistillJobStatusSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import type { MemoryDistillCommands } from '@/modules/memory/public/commands'
import { getDistillJobDetail } from '@/services/memoryDistillJobDetail'
import { getDistillJobSessionView } from '@/services/memoryDistillSessionView'
import { ConflictError, ValidationError } from '@/util/errors'
import type { MemoryDistillQueries } from '@/modules/memory/public/queries'

export function mountMemoryDistillJobRoutes(
  app: Hono,
  deps: {
    readonly memoryDistillCommands: MemoryDistillCommands
    readonly memoryDistillQueries: MemoryDistillQueries
  },
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memory-distill-jobs',
      permissions: ['memory:read', 'memory-distill-jobs:manage'],
      tokenAccess: 'allow',
      summary: 'List memory distill jobs',
    },
    async (c) => {
      const statusRaw = c.req.query('status')
      let status: string | undefined
      if (statusRaw !== undefined && statusRaw !== '') {
        const r = DistillJobStatusSchema.safeParse(statusRaw)
        if (!r.success) {
          throw new ValidationError('invalid-filter', `invalid status: ${statusRaw}`)
        }
        status = r.data
      }
      const items = await deps.memoryDistillQueries.listJobs(status !== undefined ? { status } : {})
      return c.json({ items })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memory-distill-jobs/:id/retry',
      permissions: ['memory:update', 'tasks:execute', 'memory-distill-jobs:manage'],
      tokenAccess: 'allow',
      summary: 'Retry a failed distill job (spawns a model run)',
    },
    async (c) => {
      const id = c.req.param('id')
      const ok = await deps.memoryDistillCommands.retryFailed(id)
      if (!ok) {
        // Distinguish 404 from 409 for cleaner debugging.
        throw new ConflictError(
          'distill-job-not-failed',
          `distill job ${id} is not in 'failed' state (or does not exist)`,
        )
      }
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/memory-distill-jobs/:id/cancel',
      permissions: ['memory:update', 'memory-distill-jobs:manage'],
      tokenAccess: 'allow',
      summary: 'Cancel a pending distill job',
    },
    async (c) => {
      const id = c.req.param('id')
      const ok = await deps.memoryDistillCommands.cancelPending(id)
      if (!ok) {
        throw new ConflictError(
          'distill-job-not-pending',
          `distill job ${id} is not in 'pending' state (or does not exist)`,
        )
      }
      return c.json({ ok: true })
    },
  )

  // RFC-043/RFC-305: capability-gated distill job detail page support.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memory-distill-jobs/:id',
      permissions: ['memory:read', 'memory-distill-jobs:manage'],
      tokenAccess: 'allow',
      summary: 'Get one distill job',
    },
    async (c) => {
      const detail = await getDistillJobDetail(deps.memoryDistillQueries, c.req.param('id'))
      return c.json(detail)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/memory-distill-jobs/:id/session',
      permissions: ['memory:read', 'memory-distill-jobs:manage'],
      tokenAccess: 'allow',
      summary: 'Distill job session view',
    },
    async (c) => {
      const view = await getDistillJobSessionView(deps.memoryDistillQueries, c.req.param('id'))
      return c.json(view)
    },
  )
}
