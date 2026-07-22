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

import {} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {} from '@/db/schema'
import { buildConfigActions } from '@/services/workgroup/configActions'
import { buildDwActions } from '@/services/workgroup/dwActions'
import { buildRoomReads } from '@/services/workgroup/room'
import { buildWorkgroupTaskActions, safeJson } from '@/services/workgroup/taskActions'

/** RFC-054 W1-7: zod-parse instead of `as Record` for reading our own
 * task-owned config JSON (routes/*.ts may not `as`-cast). */

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
  const core = buildWorkgroupTaskActions({ db: deps.db, configPath: deps.configPath })
  const actions = {
    ...core,
    ...buildDwActions({ db: deps.db, configPath: deps.configPath }, core),
    ...buildRoomReads({ db: deps.db }, core),
    ...buildConfigActions({ db: deps.db, configPath: deps.configPath }, core),
  }

  app.get('/api/workgroup-tasks/pending-count', async (c) =>
    c.json(await actions.pendingCount(actorOf(c))),
  )

  app.get('/api/workgroup-tasks/:taskId/room', async (c) =>
    c.json(await actions.roomAggregate(actorOf(c), c.req.param('taskId'))),
  )

  app.post('/api/workgroup-tasks/:taskId/dw-confirm', async (c) =>
    c.json(await actions.dwConfirm(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw))),
  )

  app.post('/api/workgroup-tasks/:taskId/dw-save-as-workflow', async (c) =>
    c.json(
      await actions.dwSaveAsWorkflow(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw)),
      201,
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/messages', async (c) =>
    c.json(
      await actions.postRoomMessage(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw)),
      201,
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/assignments/:id/deliver', async (c) =>
    c.json(
      await actions.deliverAssignment(
        actorOf(c),
        c.req.param('taskId'),
        c.req.param('id'),
        await safeJson(c.req.raw),
      ),
      201,
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/confirm', async (c) =>
    c.json(await actions.confirmGate(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw))),
  )

  app.put('/api/workgroup-tasks/:taskId/config', async (c) =>
    c.json(
      await actions.updateTaskConfig(actorOf(c), c.req.param('taskId'), await safeJson(c.req.raw)),
    ),
  )

  app.post('/api/workgroup-tasks/:taskId/assignments/:id/cancel', async (c) => {
    await actions.cancelAssignment(actorOf(c), c.req.param('taskId'), c.req.param('id'))
    return c.body(null, 204)
  })
}
