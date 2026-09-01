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

import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { WorkgroupTaskRoomCommands } from '@/modules/resource-catalog/public/commands'
import type { WorkgroupTaskRoomModule } from '@/modules/resource-catalog/public/operations'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { WorkgroupTaskRoomQueries } from '@/modules/resource-catalog/public/queries'
import { registerRoute } from '@/routes/registry'
import { safeJsonOrEmpty } from '@/util/http'
import { jsonDocumentResponse } from '@/util/jsonDocument'

/** A room write may re-drive only a parked or interrupted task. */
export function isWorkgroupKickResumable(status: string | undefined): boolean {
  return status === 'awaiting_human' || status === 'interrupted'
}

/** Resolve human @mentions against the frozen task roster. */
export function resolveMentions(
  body: string,
  config: WorkgroupRuntimeConfig,
): Array<{ id: string; displayName: string }> {
  const byName = new Map(config.members.map((member) => [member.displayName, member]))
  const resolved = new Map<string, { id: string; displayName: string }>()
  for (const match of body.matchAll(/@([^\s@,]+)/gu)) {
    const member = byName.get(match[1] ?? '')
    if (member !== undefined && !resolved.has(member.id)) {
      resolved.set(member.id, { id: member.id, displayName: member.displayName })
    }
  }
  return [...resolved.values()]
}

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

export interface WorkgroupTaskRouteDependencies {
  readonly module: WorkgroupTaskRoomModule
  readonly authorityFor: (actor: Actor) => WorkgroupOperationContext
}

async function submission(request: Request) {
  return Object.freeze({
    kind: 'json-body' as const,
    body: JSON.stringify(await safeJsonOrEmpty(request)),
  })
}

export function mountWorkgroupTaskRoutes(
  app: Hono,
  dependencies: WorkgroupTaskRouteDependencies,
): void {
  const commands: WorkgroupTaskRoomCommands = dependencies.module.commands
  const queries: WorkgroupTaskRoomQueries = dependencies.module.queries

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroup-tasks/pending-count',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Count of workgroup tasks awaiting input',
    },
    async (c) =>
      jsonDocumentResponse(
        (await queries.pendingCount(dependencies.authorityFor(actorOf(c)))).body,
      ),
  )

  // RFC-329 —— the rows behind that badge.
  //
  // `pendingCount` computed this exact set and threw it away, so "which workgroup
  // tasks are waiting on a human" had no listable endpoint: reviews and clarify
  // each have one, workgroup had a number and a single-task room. That asymmetry
  // is what kept `list_pending_gates` from being what it says it is.
  //
  // Same actor boundary as the badge — both go through `pendingRows`, so the two
  // cannot answer differently for the same caller.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroup-tasks/pending',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List workgroup tasks awaiting input',
    },
    async (c) =>
      jsonDocumentResponse((await queries.pending(dependencies.authorityFor(actorOf(c)))).body),
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
    async (c) =>
      jsonDocumentResponse(
        (
          await queries.room(dependencies.authorityFor(actorOf(c)), {
            taskId: c.req.param('taskId'),
          })
        ).body,
      ),
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
        await commands.confirmDynamicWorkflow(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          submission: await submission(c.req.raw),
        }),
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
        await commands.saveDynamicWorkflow(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          submission: await submission(c.req.raw),
        }),
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
        await commands.postMessage(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          submission: await submission(c.req.raw),
        }),
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
        await commands.deliverAssignment(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          assignmentId: c.req.param('id'),
          submission: await submission(c.req.raw),
        }),
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
        await commands.confirmGate(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          submission: await submission(c.req.raw),
        }),
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
        await commands.updateConfig(dependencies.authorityFor(actorOf(c)), {
          taskId: c.req.param('taskId'),
          submission: await submission(c.req.raw),
        }),
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
      await commands.cancelAssignment(dependencies.authorityFor(actorOf(c)), {
        taskId: c.req.param('taskId'),
        assignmentId: c.req.param('id'),
      })
      return c.body(null, 204)
    },
  )
}
