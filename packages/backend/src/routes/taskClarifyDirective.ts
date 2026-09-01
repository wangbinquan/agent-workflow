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

import type { Hono } from 'hono'
import { z } from 'zod'
import { ClarifyDirectiveSchema } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import type { TaskClarifyDirectiveRouteOperations } from '@/modules/task-execution/public/types'
import { isAskingNodeInSnapshot } from '@/services/taskClarifyDirective'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

const SetDirectiveBodySchema = z.object({
  directive: ClarifyDirectiveSchema,
  /**
   * RFC-207 — target ONE asker inside the node (a workgroup assignment or member)
   * instead of the whole node. Omitted ⇒ the node-level row, which is what the
   * canvas toggle sets and what a node-level 'continue' clears back to.
   */
  shardKey: z.string().min(1).optional(),
})

async function loadVisibleTask(
  operations: TaskClarifyDirectiveRouteOperations,
  taskId: string,
  actor: Actor,
) {
  const access = await operations.resolveAccess({ actor, taskId })
  if (access === null) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return access
}

export interface TaskClarifyDirectiveRouteDependencies {
  readonly operations: TaskClarifyDirectiveRouteOperations
}

export function mountTaskClarifyDirectiveRoutes(
  app: Hono,
  dependencies: TaskClarifyDirectiveRouteDependencies,
): void {
  const { operations } = dependencies
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tasks/:id/clarify-directives',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List clarify directives',
    },
    async (c) => {
      const taskId = c.req.param('id')
      await loadVisibleTask(operations, taskId, actorOf(c))
      const directives = await operations.list(taskId)
      return c.json(Object.fromEntries(directives.map((entry) => [entry.nodeId, entry.directive])))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/tasks/:id/nodes/:nodeId/clarify-directive',
      permissions: ['tasks:update'],
      tokenAccess: 'allow',
      summary: 'Set a node clarify directive',
    },
    async (c) => {
      const taskId = c.req.param('id')
      const nodeId = c.req.param('nodeId') ?? ''
      const actor = actorOf(c)
      const access = await loadVisibleTask(operations, taskId, actor)
      // Member gate (403 if not owner/collaborator/admin). The role snapshot is
      // not persisted on the directive row — the toggle is a runtime control, not
      // an attributed answer — so the return value is intentionally discarded.
      if (access.actorRole === null) {
        throw new ForbiddenError(
          'not-task-member',
          'only task members or an actor with the required global task authority can do this',
        )
      }

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
      if (!isAskingNodeInSnapshot(access.workflowSnapshot, nodeId)) {
        throw new ValidationError(
          'not-asking-node',
          `node '${nodeId}' is not a clarify asking-agent node in task ${taskId}`,
        )
      }

      await operations.set({
        taskId,
        nodeId,
        directive: parsed.data.directive,
        setBy: actor.user.id,
        ...(parsed.data.shardKey === undefined ? {} : { shardKey: parsed.data.shardKey }),
      })
      return c.json({
        ok: true,
        nodeId,
        directive: parsed.data.directive,
        ...(parsed.data.shardKey !== undefined ? { shardKey: parsed.data.shardKey } : {}),
      })
    },
  )
}
