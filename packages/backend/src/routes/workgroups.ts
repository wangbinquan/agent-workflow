// Workgroup HTTP routes (RFC-164 PR-1).
// GET    /api/workgroups                — list (ACL-filtered)
// GET    /api/workgroups/:id            — one (invisible → 404, D1)
// POST   /api/workgroups                — create (creator becomes owner)
// POST   /api/workgroups/:id/copy       — exact-revision private copy
// PUT    /api/workgroups/:id            — RFC-225 version-fenced full document save
// DELETE /api/workgroups/:id            — RFC-225 version-fenced delete
// POST   /api/workgroups/:id/rename     — fenced compatibility adapter
// GET/PUT /api/workgroups/:id/acl       — RFC-099 ACL management
//
// RFC-099 D15 / RFC-223: creating/updating checks that NEW agent-member ids are
// usable by the editor, enforced inside create/saveWorkgroup against the exact
// ids persisted.

import {
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  rejectRetiredStartTaskKeys,
  RenameWorkgroupSchema,
  StartWorkgroupTaskSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { WorkgroupOperationDescriptors } from '@/modules/resource-catalog/public/operations'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { WorkgroupQueries } from '@/modules/resource-catalog/public/queries'
import type { WorkgroupCatalogDetail } from '@/modules/resource-catalog/public/types'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { registerOperationRoute } from '@/routes/operationRoute'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
// RFC-243 T2: workgroup launches go through the unified executor facade — this
// route must not call startWorkgroupTask directly (source-text lock).
import { startExecution } from '@/services/execution/executor'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { requireSchedulerDriver } from '@/modules/task-execution/public/commands'
import { NotFoundError, ValidationError } from '@/util/errors'
import {
  evaluateAgentResourceIntegrity,
  loadAgentResourceInventory,
} from '@/services/agentResourceIntegrity'
import { safeJsonOrEmpty } from '@/util/http'

export interface WorkgroupRouteDependencies {
  readonly queries: WorkgroupQueries
  readonly operations: WorkgroupOperationDescriptors
  readonly authorityFor: (actor: Actor) => WorkgroupOperationContext
}

export function mountWorkgroupRoutes(
  app: Hono,
  deps: AppDeps,
  module: WorkgroupRouteDependencies,
): void {
  const { queries, operations } = module

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, id: string): Promise<WorkgroupCatalogDetail> {
    const group = await queries.get(module.authorityFor(actor), { id })
    if (group === null) {
      throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    }
    return group
  }

  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/workgroups',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, list) => c.json(list),
  })

  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, group) => {
      if (group === null) throw new NotFoundError('workgroup-not-found', 'workgroup not found')
      return c.json(group)
    },
  })

  // RFC-228: advisory status for the editor/wizard. The POST launch service
  // always recomputes this; this endpoint only prevents a known-bad click and
  // deliberately omits referenced ids/names from implicit ACL closures.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroups/:id/resource-status',
      permissions: ['workgroups:read'],
      tokenAccess: 'allow',
      summary: 'Advisory referenced-resource status for a workgroup',
    },
    async (c) => {
      const group = await loadVisibleWorkgroup(actorOf(c), c.req.param('id'))
      const memberAgentIds = group.members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      )
      const result = evaluateAgentResourceIntegrity(
        await loadAgentResourceInventory(deps.db),
        memberAgentIds,
      )
      return c.json({
        ok: result.ok,
        issues: result.issues.map((issue) => ({
          code: issue.code,
          rootAgentId: issue.rootAgentId,
          refKind: issue.refKind,
          direct: issue.ownerAgentId === issue.rootAgentId,
        })),
      })
    },
  )

  registerOperationRoute(app, {
    descriptor: operations.create,
    method: 'POST',
    path: '/api/workgroups',
    tokenAccess: 'allow',
    decode: async (c) => {
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = CreateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      return parsed.data
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, created) => c.json(created, 201),
  })

  registerOperationRoute(app, {
    descriptor: operations.copy,
    method: 'POST',
    path: '/api/workgroups/:id/copy',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = CopyWorkgroupRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workgroup-copy-invalid', 'invalid workgroup copy payload', {
          issues: parsed.error.issues,
        })
      }
      return { id: c.req.param('id'), copy: parsed.data }
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, copied) => c.json(copied, 201),
  })

  registerOperationRoute(app, {
    descriptor: operations.update,
    method: 'PUT',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = UpdateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      return { id, update: parsed.data }
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, updated) => c.json(updated),
  })

  registerOperationRoute(app, {
    descriptor: operations.delete,
    method: 'DELETE',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: async (c) => ({
      id: c.req.param('id'),
      deletion: {
        kind: 'json-body',
        body: await c.req.raw.text().catch(() => ''),
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.body(null, 204)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.rename,
    method: 'POST',
    path: '/api/workgroups/:id/rename',
    tokenAccess: 'allow',
    decode: async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = RenameWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      return { id, rename: parsed.data }
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, renamed) => c.json(renamed),
  })

  // RFC-164 PR-3 — launch a workgroup task. Service-layer entry (the builtin
  // host workflow would 403 assertWorkflowLaunchable by design); the group
  // itself is the launch permission surface (view ⇒ launch, RFC-099 D3).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroups/:id/tasks',
      // RFC-165 F15/N1 — see routes/agents.ts: all three launch endpoints gate
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
          await assertCanReplaySourceTask(deps.db, actorOf(c), src)
        }
      }
      const parsed = StartWorkgroupTaskSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
          issues: parsed.error.issues,
        })
      }
      const task = await startExecution(
        deps.db,
        actor,
        {
          kind: 'workgroup',
          refId: existing.id,
          invoker: { type: 'user', launchKind: 'direct-json' },
          payload: parsed.data,
        },
        buildStartTaskDeps(
          deps.db,
          requireSchedulerDriver(deps.schedulerDriver),
          deps.configPath,
          actor.user.id,
          undefined,
          deps.identityAccess,
        ),
      )
      return c.json(task, 201)
    },
  )

  // RFC-099 / RFC-223 — GET/PUT /api/workgroups/:id/acl
  registerOperationRoute(app, {
    descriptor: operations.getAcl,
    method: 'GET',
    path: '/api/workgroups/:id/acl',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })

  registerOperationRoute(app, {
    descriptor: operations.updateAcl,
    method: 'PUT',
    path: '/api/workgroups/:id/acl',
    tokenAccess: 'never',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: {
        kind: 'json-body',
        body: JSON.stringify(await safeJsonOrEmpty(c.req.raw)) ?? '{}',
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })
}
