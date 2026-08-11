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
  DeleteWorkgroupSchema,
  rejectRetiredStartTaskKeys,
  RenameWorkgroupSchema,
  StartWorkgroupTaskSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { assertCanReplaySourceTask } from '@/services/taskCollab'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertDeleteConfirm } from '@/services/deleteConfirm'
import {
  copyWorkgroup,
  createWorkgroup,
  deleteWorkgroup,
  getWorkgroupById,
  listWorkgroups,
  renameWorkgroup,
  saveWorkgroup,
} from '@/services/workgroups'
// RFC-243 T2: workgroup launches go through the unified executor facade — this
// route must not call startWorkgroupTask directly (source-text lock).
import { startExecution } from '@/services/execution/executor'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'
import {
  evaluateAgentResourceIntegrity,
  loadAgentResourceInventory,
} from '@/services/agentResourceIntegrity'

export function mountWorkgroupRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, id: string) {
    const group = await getWorkgroupById(deps.db, id)
    if (group === null || !(await canViewResource(deps.db, actor, 'workgroup', group))) {
      throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    }
    return group
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroups',
      permissions: ['workgroups:read'],
      tokenAccess: 'allow',
      summary: 'List workgroups visible to the caller',
    },
    async (c) => {
      const list = await listWorkgroups(deps.db)
      return c.json(await filterVisibleRows(deps.db, actorOf(c), 'workgroup', list))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroups/:id',
      permissions: ['workgroups:read'],
      tokenAccess: 'allow',
      summary: 'Get one workgroup',
    },
    async (c) => {
      return c.json(await loadVisibleWorkgroup(actorOf(c), c.req.param('id')))
    },
  )

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

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroups',
      permissions: ['workgroups:create'],
      tokenAccess: 'allow',
      summary: 'Create a workgroup',
    },
    async (c) => {
      const body = await safeJson(c.req.raw)
      const parsed = CreateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      // RFC-223 (PR-1, Codex impl-gate P1-2): member reference ACL is enforced
      // INSIDE createWorkgroup, bound to the same single resolution that produces
      // the persisted member agentIds (no check-then-resolve TOCTOU).
      const created = await createWorkgroup(deps.db, parsed.data, {
        ownerUserId: actor.user.id,
        actor,
      })
      return c.json(created, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroups/:id/copy',
      permissions: ['workgroups:create'],
      tokenAccess: 'allow',
      summary: 'Copy a workgroup into a private duplicate',
    },
    async (c) => {
      const parsed = CopyWorkgroupRequestSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workgroup-copy-invalid', 'invalid workgroup copy payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(await copyWorkgroup(deps.db, c.req.param('id'), parsed.data, actorOf(c)), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/workgroups/:id',
      permissions: ['workgroups:update'],
      tokenAccess: 'allow',
      summary: 'Replace a workgroup document (version fenced)',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJson(c.req.raw)
      const parsed = UpdateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const existing = await loadVisibleWorkgroup(actor, id)
      await requireResourceOwner(deps.db, actor, 'workgroup', existing)
      return c.json(
        await saveWorkgroup(deps.db, existing.id, parsed.data, { kind: 'actor', actor }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/workgroups/:id',
      permissions: ['workgroups:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a workgroup (version fenced)',
    },
    async (c) => {
      const id = c.req.param('id')
      const actor = actorOf(c)
      const existing = await loadVisibleWorkgroup(actor, id)
      await requireResourceOwner(deps.db, actor, 'workgroup', existing)
      const parsed = DeleteWorkgroupSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup delete payload', {
          issues: parsed.error.issues,
        })
      }
      // RFC-222 (D5): type-to-confirm (N-5 order).
      assertDeleteConfirm(parsed.data, existing.name, 'workgroup')
      captureDeleteSnapshot(c, actor, existing)
      await deleteWorkgroup(deps.db, existing.id, parsed.data, { kind: 'actor', actor })
      return c.body(null, 204)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/workgroups/:id/rename',
      permissions: ['workgroups:update'],
      tokenAccess: 'allow',
      summary: 'Rename a workgroup',
    },
    async (c) => {
      const id = c.req.param('id')
      const body = await safeJson(c.req.raw)
      const parsed = RenameWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const existing = await loadVisibleWorkgroup(actor, id)
      await requireResourceOwner(deps.db, actor, 'workgroup', existing)
      return c.json(
        await renameWorkgroup(deps.db, existing.id, parsed.data, {
          kind: 'actor',
          actor,
        }),
      )
    },
  )

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
      const body = await safeJson(c.req.raw)
      // RFC-165 实现门 P2 修复：即便本 schema 从未声明退役键，非 strict parse
      // 仍会把 {scratch:true, repoPath} 静默剥键降级成 scratch 启动（F1
      // silent-degrade 同型）——四个 launch 入口一致挂 raw-key 拒收。
      const retired = rejectRetiredStartTaskKeys(body)
      if (retired !== null) {
        throw new ValidationError(
          'start-task-path-retired',
          `field '${retired}' was retired by RFC-165 — launch with repoUrl/repos (file:// for local repos) or scratch`,
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
          invoker: { type: 'user' },
          payload: parsed.data,
        },
        buildStartTaskDeps(deps.db, deps.configPath, actor.user.id, undefined),
      )
      return c.json(task, 201)
    },
  )

  // RFC-099 / RFC-223 — GET/PUT /api/workgroups/:id/acl
  mountAclEndpoints(app, deps, {
    type: 'workgroup',
    base: '/api/workgroups',
    param: 'id',
    load: (db, id) => getWorkgroupById(db, id),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
