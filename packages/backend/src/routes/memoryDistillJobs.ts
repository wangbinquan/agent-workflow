// RFC-041 — admin monitoring + control of the distill queue (PR2 scope).
//
//   GET  /api/memory-distill-jobs[?status=pending|running|done|failed|canceled]
//   POST /api/memory-distill-jobs/:id/retry    failed → pending
//   POST /api/memory-distill-jobs/:id/cancel   pending → canceled
//
// RFC-222: resource-admin (admin OR manager) — D3 — gated by `memory:approve` which sits in the
// admin baseline (see permissions.ts). The same permission point governs
// the candidate approval queue, so the operator who can approve a
// candidate can also tell the worker to retry / skip distill jobs.

import { DistillJobStatusSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { requireResourceAdmin } from '@/auth/permissions'
import {
  cancelPendingJob,
  listDistillJobs,
  retryFailedJob,
} from '@/services/memoryDistillScheduler'
import { getDistillJobDetail } from '@/services/memoryDistillJobDetail'
import { getDistillJobSessionView } from '@/services/memoryDistillSessionView'
import { ConflictError, ValidationError } from '@/util/errors'

export function mountMemoryDistillJobRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/memory-distill-jobs', requireResourceAdmin('memory:approve'), async (c) => {
    const statusRaw = c.req.query('status')
    let status: string | undefined
    if (statusRaw !== undefined && statusRaw !== '') {
      const r = DistillJobStatusSchema.safeParse(statusRaw)
      if (!r.success) {
        throw new ValidationError('invalid-filter', `invalid status: ${statusRaw}`)
      }
      status = r.data
    }
    const items = await listDistillJobs(deps.db, status !== undefined ? { status } : {})
    return c.json({ items })
  })

  app.post(
    '/api/memory-distill-jobs/:id/retry',
    requireResourceAdmin('memory:approve'),
    async (c) => {
      const id = c.req.param('id')
      const ok = await retryFailedJob(deps.db, id)
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

  app.post(
    '/api/memory-distill-jobs/:id/cancel',
    requireResourceAdmin('memory:approve'),
    async (c) => {
      const id = c.req.param('id')
      const ok = await cancelPendingJob(deps.db, id)
      if (!ok) {
        throw new ConflictError(
          'distill-job-not-pending',
          `distill job ${id} is not in 'pending' state (or does not exist)`,
        )
      }
      return c.json({ ok: true })
    },
  )

  // RFC-043: admin-only distill job detail page support.
  app.get('/api/memory-distill-jobs/:id', requireResourceAdmin('memory:approve'), async (c) => {
    const detail = await getDistillJobDetail(deps.db, c.req.param('id'))
    return c.json(detail)
  })

  app.get(
    '/api/memory-distill-jobs/:id/session',
    requireResourceAdmin('memory:approve'),
    async (c) => {
      const view = await getDistillJobSessionView(deps.db, c.req.param('id'))
      return c.json(view)
    },
  )
}
