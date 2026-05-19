// RFC-041 — per-task feedback REST surface (PR2 scope).
//
//   GET  /api/tasks/:taskId/feedback   — task-viewers (RFC-036 visibility)
//   POST /api/tasks/:taskId/feedback   — task-viewers + memory:write_feedback
//
// Both endpoints first 404 if the task doesn't exist, then 403 if the
// caller can't see the task (canViewTask), to avoid leaking task ids via
// timing diff. POST returns the persisted row + the distill_job_id so the
// frontend can show "queued" in the UI.

import { TaskFeedbackCreateSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppDeps } from '@/server'
import { actorOf } from '@/auth/actor'
import { requirePermission } from '@/auth/permissions'
import { tasks } from '@/db/schema'
import { createTaskFeedback, listTaskFeedback } from '@/services/taskFeedback'
import { canViewTask } from '@/services/taskCollab'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

export function mountTaskFeedbackRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:taskId/feedback', requirePermission('memory:read'), async (c) => {
    const taskId = c.req.param('taskId')
    await assertVisible(c, deps, taskId)
    const items = await listTaskFeedback(deps.db, taskId)
    return c.json({ items })
  })

  app.post('/api/tasks/:taskId/feedback', requirePermission('memory:write_feedback'), async (c) => {
    const taskId = c.req.param('taskId')
    await assertVisible(c, deps, taskId)
    const body = await c.req.json().catch(() => ({}))
    const parsed = TaskFeedbackCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('invalid-body', 'invalid feedback body', parsed.error.format())
    }
    const actor = actorOf(c)
    const result = await createTaskFeedback(deps.db, {
      taskId,
      authorUserId: actor.user.id,
      bodyMd: parsed.data.bodyMd,
    })
    return c.json({ feedback: result.feedback, distillJobId: result.distillJobId }, 201)
  })
}

async function assertVisible(c: Context, deps: AppDeps, taskId: string): Promise<void> {
  const rows = await deps.db
    .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (rows.length === 0) throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  const visible = await canViewTask(deps.db, actorOf(c), rows[0]!)
  if (!visible) throw new ForbiddenError('task-not-visible', `task ${taskId} not visible`)
}
