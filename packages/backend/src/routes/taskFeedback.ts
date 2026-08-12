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
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import { tasks } from '@/db/schema'
import { createTaskFeedback, listTaskFeedback } from '@/services/taskFeedback'
import { canViewTask } from '@/services/taskCollab'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountTaskFeedbackRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:taskId/feedback',
      permissions: ['memory:read'],
      tokenAccess: 'allow',
      summary: 'List task feedback',
    },
    async (c) => {
      const taskId = c.req.param('taskId')
      await assertVisible(c, deps, taskId)
      const items = await listTaskFeedback(deps.db, taskId)
      return c.json({ items })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:taskId/feedback',
      permissions: ['memory:create'],
      tokenAccess: 'allow',
      summary: 'Write task feedback',
    },
    async (c) => {
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
    },
  )
}

async function assertVisible(c: Context, deps: AppDeps, taskId: string): Promise<void> {
  const rows = await deps.db
    .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  // RFC-285 B1：两分支文案与 tasks.ts visibilityCheck 中间件逐字节同形（带引号
  // 形）。byte-oracle 实测抓过残余可区分性：本路由挂在 /api/tasks/:id/* 中间件
  // 之下，「不可见」被中间件先拦（带引号文案）、「缺失」才落到本函数——此处
  // 若用无引号旧文案，两形态字节不同，探测面复活。
  if (rows.length === 0) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  const visible = await canViewTask(deps.db, actorOf(c), rows[0]!)
  if (!visible) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
}
