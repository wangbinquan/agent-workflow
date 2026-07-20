// RFC-122 — REST endpoints for the per-(task, asking-node) clarify directive
// toggle (on-canvas "继续反问 / 停止反问").
//
//   GET  /api/tasks/:id/clarify-directives                 map { nodeId: directive }
//   POST /api/tasks/:id/nodes/:nodeId/clarify-directive    set { directive }
//
// Auth: token middleware applies via createApp's app.use('/api/*', ...). Read
// inherits task visibility (canViewTask → 404 mirrors the task routes); the
// write requires task membership (requireTaskMember → 403). The node must be an
// asking-agent node in the task's workflow snapshot (isClarifyAskingNode) — a
// clarify / clarify-cross-agent CHANNEL node or any non-asking node → 422, so
// the toggle can never be set where the runtime would ignore it.

import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { ClarifyDirectiveSchema } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import {
  isAskingNodeInSnapshot,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
} from '@/services/taskClarifyDirective'
import { NotFoundError, ValidationError } from '@/util/errors'

const SetDirectiveBodySchema = z.object({
  directive: ClarifyDirectiveSchema,
  /**
   * RFC-207 — target ONE asker inside the node (a workgroup assignment or member)
   * instead of the whole node. Omitted ⇒ the node-level row, which is what the
   * canvas toggle sets and what a node-level 'continue' clears back to.
   */
  shardKey: z.string().min(1).optional(),
})

async function loadVisibleTask(deps: AppDeps, taskId: string, actor: Actor) {
  const [t] = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
  if (!t || !(await canViewTask(deps.db, actor, t))) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return t
}

export function mountTaskClarifyDirectiveRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:id/clarify-directives', async (c) => {
    const taskId = c.req.param('id')
    await loadVisibleTask(deps, taskId, actorOf(c))
    return c.json(await listNodeClarifyDirectives(deps.db, taskId))
  })

  app.post('/api/tasks/:id/nodes/:nodeId/clarify-directive', async (c) => {
    const taskId = c.req.param('id')
    const nodeId = c.req.param('nodeId') ?? ''
    const actor = actorOf(c)
    const task = await loadVisibleTask(deps, taskId, actor)
    // Member gate (403 if not owner/collaborator/admin). The role snapshot is
    // not persisted on the directive row — the toggle is a runtime control, not
    // an attributed answer — so the return value is intentionally discarded.
    await requireTaskMember(deps.db, actor, task)

    const parsed = SetDirectiveBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      throw new ValidationError(
        'clarify-directive-invalid',
        "directive must be 'continue' or 'stop'",
        { issues: parsed.error.issues },
      )
    }

    // The node must be an asking-agent node in the frozen workflow snapshot. The
    // service owns the JSON.parse so the route never casts unknown → a type
    // (RFC-054 W1-7); an unreadable snapshot just resolves to false → 422.
    if (!isAskingNodeInSnapshot(task.workflowSnapshot, nodeId)) {
      throw new ValidationError(
        'not-asking-node',
        `node '${nodeId}' is not a clarify asking-agent node in task ${taskId}`,
      )
    }

    await setNodeClarifyDirective(
      deps.db,
      taskId,
      nodeId,
      parsed.data.directive,
      actor.user.id,
      parsed.data.shardKey,
    )
    return c.json({
      ok: true,
      nodeId,
      directive: parsed.data.directive,
      ...(parsed.data.shardKey !== undefined ? { shardKey: parsed.data.shardKey } : {}),
    })
  })
}
