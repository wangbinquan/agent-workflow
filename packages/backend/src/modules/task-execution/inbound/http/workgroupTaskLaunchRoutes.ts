// RFC-589 — launch a workgroup task (`POST /api/workgroups/:id/tasks`). Moved verbatim from the workgroup routes (formerly
// `routes/workgroups.ts`, now resource-catalog's `inbound/http/workgroupRoutes.ts`) for the same reason as the agent
// launch binding: launching is a task-execution operation, and resource-catalog may not take task-execution's launch
// operations. The workgroup is read through resource-catalog's public query first (missing and not visible: the same
// 404). The assembly root mounts this right after `mountWorkgroupRoutes`, with the same dependency object.

import { rejectRetiredStartTaskKeys, StartWorkgroupTaskSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { WorkgroupQueries } from '@/modules/resource-catalog/public/queries'
import type { WorkgroupCatalogDetail } from '@/modules/resource-catalog/public/types'
import { registerRoute } from '@/routes/registry'
// RFC-243 T2: workgroup launches go through the unified executor facade — this
// route must not call startWorkgroupTask directly (source-text lock).
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { safeJsonOrEmpty } from '@/platform/http/requestParsing'
import type { WorkgroupRouteTaskLaunchOperations } from '../../application/ports/subjectTaskLaunch'

export interface WorkgroupTaskLaunchRouteDependencies {
  /** The workgroup the launch starts from (resource-catalog's catalog query; only `get` is used). */
  readonly queries: Pick<WorkgroupQueries, 'get'>
  readonly authorityFor: (actor: Actor) => WorkgroupOperationContext
  /** Required TaskExecution launch seam; no provider client crosses the route. */
  readonly taskLaunch: WorkgroupRouteTaskLaunchOperations
}

export function mountWorkgroupTaskLaunchRoutes(
  app: Hono,
  module: WorkgroupTaskLaunchRouteDependencies,
): void {
  const { queries } = module

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, id: string): Promise<WorkgroupCatalogDetail> {
    const group = await queries.get(module.authorityFor(actor), { id })
    if (group === null) {
      throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    }
    return group
  }

  // RFC-164 PR-3 — launch a workgroup task. Service-layer entry (the builtin
  // host workflow would 403 assertWorkflowLaunchable by design); the group
  // itself is the launch permission surface (view ⇒ launch, RFC-099 D3).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroups/:id/tasks',
      executionGroup: 'task',
      // RFC-165 F15/N1 — see the agent launch binding: all three launch endpoints gate
      // uniformly on the task execute point.
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Launch a workgroup task',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleWorkgroup(actor, c.req.param('id'))
      const body = await safeJsonOrEmpty(c.req.raw)
      // RFC-165 实现门 P2 修复：即便本 schema 从未声明退役键，非 strict parse
      // 仍会把 {scratch:true, repoPath} 静默剥键降级成 scratch 启动（F1
      // silent-degrade 同型）——四个 launch 入口一致挂 raw-key 拒收。
      const retired = rejectRetiredStartTaskKeys(body)
      if (retired !== null) {
        const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
        throw new ValidationError(
          clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
          clientOwnedGitIdentity
            ? `RFC-320 derives Git commit identity from the task creator; remove '${retired}'`
            : `field '${retired}' was retired by RFC-165 — launch with repoUrl/repos (file:// for local repos) or scratch`,
        )
      }

      // RFC-248 H9（实现门 P1）：`sourceTaskId` 由调用方控制。重放前先确认
      // 他**看得见**那个任务——否则「能启动某工作流但看不见任务 X」的用户可以
      // 传 X 的 id，让服务端读出 X 冻结的仓库构成并按它物化，而且泄漏形式是
      // 「任务成功启动」，完全不像一次越权。不可见与不存在同形（都 404）。
      {
        const src = (body as { sourceTaskId?: unknown }).sourceTaskId
        if (typeof src === 'string' && src.length > 0) {
          await module.taskLaunch.assertReplayVisible(actor, src)
        }
      }
      const parsed = StartWorkgroupTaskSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
          issues: parsed.error.issues,
        })
      }
      const task = await module.taskLaunch.launch(actor, {
        workgroupId: existing.id,
        payload: parsed.data,
      })
      return c.json(task, 201)
    },
  )
}
