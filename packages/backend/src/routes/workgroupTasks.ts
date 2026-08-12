// RFC-164 PR-4 — workgroup room endpoints (task-scoped; design §7).
// GET  /api/workgroup-tasks/:taskId/room                    — room aggregate
// POST /api/workgroup-tasks/:taskId/messages                — human speaks
// POST /api/workgroup-tasks/:taskId/assignments/:id/cancel  — cancel a card
//
// Visibility = task membership (canViewTask), the same boundary as clarify
// answering (RFC-099 D20 — group tasks are member-private like every task).
// Room events ride the EXISTING per-task WS channel as wg.* frames.
//
// Human message semantics (决策 #14): "@member" tokens = direct dispatch
// (one assignment per mentioned member, card notes source=human); a message
// with no mentions lands on the blackboard and re-wakes a leader-idle task
// (design §8.3 — resumeTask kicks the engine; leader picks it up as
// new-content).

import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { buildConfigActions } from '@/services/workgroup/configActions'
import { buildDwActions } from '@/services/workgroup/dwActions'
import { buildRoomReads } from '@/services/workgroup/room'
import { buildWorkgroupTaskActions } from '@/services/workgroup/taskActions'
import { safeJsonOrEmpty } from '@/util/http'

export { isWorkgroupKickResumable, resolveMentions } from '@/services/workgroup/taskActions'

/**
 * 2026-07-21 —— 房间响应的 `pauseReason`：任务当前停在 awaiting_human 时读
 * workgroup_task_state.pause_reason（引擎在返回 awaiting_human 前写入，RFC-217
 * T2 出 JSON 槽），否则恒 null（读方门槛：陈值永不外泄，列无需清理）。纯函数
 * 导出供测试直锁——与 isWorkgroupKickResumable 同款先例。
 */
export function resolveRoomPauseReason(
  taskStatus: string,
  pauseReason: string | null,
): string | null {
  if (taskStatus !== 'awaiting_human') return null
  return pauseReason !== null && pauseReason.length > 0 ? pauseReason : null
}

export function mountWorkgroupTaskRoutes(app: Hono, deps: AppDeps): void {
  const core = buildWorkgroupTaskActions({
    db: deps.db,
    configPath: deps.configPath,
  })
  const actions = {
    ...core,
    ...buildDwActions({ db: deps.db, configPath: deps.configPath }, core),
    ...buildRoomReads({ db: deps.db }, core),
    ...buildConfigActions({ db: deps.db, configPath: deps.configPath }, core),
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroup-tasks/pending-count',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Count of workgroup tasks awaiting input',
    },
    async (c) => c.json(await actions.pendingCount(actorOf(c))),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroup-tasks/:taskId/room',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Workgroup task room state',
    },
    async (c) => c.json(await actions.roomAggregate(actorOf(c), c.req.param('taskId'))),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/dw-confirm',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Confirm a generated dynamic workflow',
    },
    async (c) =>
      c.json(
        await actions.dwConfirm(
          actorOf(c),
          c.req.param('taskId'),
          await safeJsonOrEmpty(c.req.raw),
        ),
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/dw-save-as-workflow',
      permissions: ['tasks:execute', 'workflows:create'],
      tokenAccess: 'allow',
      summary: 'Persist a dynamic workflow as a real workflow resource',
    },
    async (c) =>
      c.json(
        await actions.dwSaveAsWorkflow(
          actorOf(c),
          c.req.param('taskId'),
          await safeJsonOrEmpty(c.req.raw),
        ),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/messages',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Post a room message',
    },
    async (c) =>
      c.json(
        await actions.postRoomMessage(
          actorOf(c),
          c.req.param('taskId'),
          await safeJsonOrEmpty(c.req.raw),
        ),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/assignments/:id/deliver',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Deliver an assignment',
    },
    async (c) =>
      c.json(
        await actions.deliverAssignment(
          actorOf(c),
          c.req.param('taskId'),
          c.req.param('id'),
          await safeJsonOrEmpty(c.req.raw),
        ),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/confirm',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Confirm a workgroup task step',
    },
    async (c) =>
      c.json(
        await actions.confirmGate(
          actorOf(c),
          c.req.param('taskId'),
          await safeJsonOrEmpty(c.req.raw),
        ),
      ),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/workgroup-tasks/:taskId/config',
      permissions: ['tasks:update'],
      tokenAccess: 'never',
      summary: 'Update workgroup task config (members / switches)',
    },
    async (c) =>
      c.json(
        await actions.updateTaskConfig(
          actorOf(c),
          c.req.param('taskId'),
          await safeJsonOrEmpty(c.req.raw),
        ),
      ),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroup-tasks/:taskId/assignments/:id/cancel',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Cancel an assignment',
    },
    async (c) => {
      await actions.cancelAssignment(actorOf(c), c.req.param('taskId'), c.req.param('id'))
      return c.body(null, 204)
    },
  )
}
