// RFC-159 — scheduled-task HTTP routes.
// GET    /api/scheduled-tasks       — list (owner + `tasks:read:all` sees all)
// GET    /api/scheduled-tasks/:id   — one (invisible == 404)
// POST   /api/scheduled-tasks       — create (owner = actor; create-time launch gate)
// PUT    /api/scheduled-tasks/:id   — update (owner/`resource-acl:bypass`)
// DELETE /api/scheduled-tasks/:id   — delete (owner/`resource-acl:bypass`)
//
// Member-based-private like tasks (owner_user_id + `tasks:read:all` bypass),
// NOT the RFC-099 five-type ACL. Run history for a schedule = its launched tasks
// via GET /api/tasks?scheduledTaskId= (see routes/tasks.ts).
import {
  CreateScheduledTaskSchema,
  rejectRetiredStartTaskKeys,
  UpdateScheduleAclBodySchema,
  UpdateScheduledTaskSchema,
} from '@agent-workflow/shared'
import type { ScheduledTask } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { assertTokenDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { buildScheduleLaunch } from '@/services/scheduleLaunch'
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  getScheduleAcl,
  listScheduledTaskItems,
  resolveScheduleAccessFor,
  runScheduleNow,
  updateScheduleAcl,
  updateScheduledTask,
  type ScheduleAuthorityRuntime,
} from '@/services/scheduledTasks'
import { canEditAccess, canGovernAccess } from '@/services/resourceAcl'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { loadConfig } from '@/config'
import { safeJsonOrThrowInvalid } from '@/util/http'
import { requireSchedulerDriver } from '@/modules/task-execution/public/commands'
import type { DirectAuthorityBinding } from '@/modules/identity-access/public/participants'
import { directRequestAuthority } from '@/routes/operationAuthority'

/**
 * RFC-324 —— 排期写权：owner / `write` 授权 / ACL bypass。
 *
 * 覆盖「改 cron、启停、立即运行」。**不覆盖改绑目标**，见下面的
 * `requireScheduleGovern`。
 */
async function requireScheduleEdit(deps: AppDeps, actor: Actor, row: ScheduledTask): Promise<void> {
  const access = await resolveScheduleAccessFor(deps.db, actor, row)
  if (canEditAccess(access)) return
  throw new ForbiddenError(
    'resource-read-only',
    `you have read-only access to scheduled task '${row.id}'`,
  )
}

/**
 * RFC-324 —— 治理写：删除、改名、改绑启动目标、改授权。
 *
 * **改绑目标为什么不是内容写**：定时任务到点是以 **owner 的身份**发起的
 * （`services/scheduledTasks.ts` 的 `buildInheritedActor(db, row.ownerUserId, 'schedule')`），
 * 所以「谁能改 launchKind / launchPayload」等于「谁能借 owner 的身份跑任意东西」。
 * 这正是 `db/schema.ts` 记的设计门 F-9 当初把定时任务与资源 ACL grants 划开的理由；
 * RFC-324 引入授权面时保留了那条结论，只把不涉及执行身份的那半边（节奏与启停）
 * 开放给 `write` 授权。
 */
async function requireScheduleGovern(
  deps: AppDeps,
  actor: Actor,
  row: ScheduledTask,
): Promise<void> {
  const access = await resolveScheduleAccessFor(deps.db, actor, row)
  if (canGovernAccess(access)) return
  throw new ForbiddenError(
    'resource-govern-owner-only',
    `deleting, renaming, re-targeting or re-granting scheduled task '${row.id}' is reserved for its owner`,
  )
}

async function loadVisible(deps: AppDeps, actor: Actor, id: string): Promise<ScheduledTask> {
  const row = await getScheduledTask(deps.db, id)
  // Invisible == missing (same 404) so a non-owner can't probe existence.
  // RFC-324 —— 判定必须查一次授权表：只判 owner 会让被授权者看不见自己被授权的
  // 那条调度，于是「授权了却 404」——比拒绝更难排查。
  if (row === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  const access = await resolveScheduleAccessFor(deps.db, actor, row)
  if (access === 'none') {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  return row
}

/** RFC-165 (N1-r3): the launch-arming operations gate. */
function requireLaunchPermission(actor: Actor): void {
  if (!actor.permissions.has('tasks:execute')) {
    throw new ForbiddenError('forbidden', 'missing permission: tasks:launch', {
      requiredPermission: 'tasks:execute',
    })
  }
}

export function mountScheduledTaskRoutes(
  app: Hono,
  deps: AppDeps & {
    readonly identityAccess: ScheduleAuthorityRuntime & {
      readonly directAuthority: DirectAuthorityBinding
    }
  },
): void {
  const resourceAuthority = (c: Parameters<typeof actorOf>[0]) => {
    const actor = actorOf(c)
    return Object.freeze({
      actor,
      authority: directRequestAuthority(deps.identityAccess.directAuthority, actor),
      resources: deps.identityAccess.integrationTriggerResources,
      taskExecutionResources: deps.identityAccess.taskExecutionResources,
    })
  }
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/scheduled-tasks',
      permissions: ['scheduled-tasks:read'],
      tokenAccess: 'allow',
      summary: 'List scheduled tasks visible to the caller',
    },
    async (c) => {
      return c.json(await listScheduledTaskItems(deps.db, actorOf(c)))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/scheduled-tasks/:id',
      permissions: ['scheduled-tasks:read'],
      tokenAccess: 'allow',
      summary: 'Get one scheduled task',
    },
    async (c) => {
      return c.json(await loadVisible(deps, actorOf(c), c.req.param('id')))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/scheduled-tasks',
      permissions: ['scheduled-tasks:create', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Create a scheduled task (arms a future launch)',
    },
    async (c) => {
      // RFC-165 (N1-r3): creating a schedule arms future launches — same
      // delegation as launching, so the same tasks:launch permission.
      requireLaunchPermission(actorOf(c))
      const rawBody = await safeJsonOrThrowInvalid(c.req.raw)
      // RFC-165 (F1): reject retired path-mode keys inside the stored payload
      // BEFORE parsing (non-strict zod would silently strip them and persist a
      // silently-degraded schedule).
      {
        const retired = rejectRetiredStartTaskKeys(
          (rawBody as { launchPayload?: unknown } | null)?.launchPayload ?? null,
        )
        if (retired !== null) {
          const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
          throw new ValidationError(
            clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
            clientOwnedGitIdentity
              ? `RFC-320 derives Git commit identity from the schedule owner; remove '${retired}' from launchPayload`
              : `RFC-165 retired path-mode launches; remove '${retired}' from launchPayload (push the repo to a real remote and register it, then launch by cachedRepoId)`,
          )
        }
      }
      const parsed = CreateScheduledTaskSchema.safeParse(rawBody)
      if (!parsed.success) {
        throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task', {
          issues: parsed.error.issues,
        })
      }
      const created = await createScheduledTask(deps.db, parsed.data, {
        actor: actorOf(c),
        resourceAuthority: resourceAuthority(c),
        defaultRuntime: loadConfig(deps.configPath).defaultRuntime,
      })
      return c.json(created, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/scheduled-tasks/:id',
      // RFC-247 note: deliberately NOT `+ tasks:execute`, unlike POST and
      // run-now. RFC-165 N1-r3 makes this gate PAYLOAD-CONDITIONAL — renaming a
      // schedule or editing a disabled one's spec stays open, only an edit that
      // actually ARMS a launch needs the execute point. Static route metadata
      // cannot express "depends on the body", and declaring the stricter gate
      // here would silently revoke a capability RFC-165 deliberately granted.
      // The conditional check lives where it can see the payload:
      // services/scheduledTasks.ts `armsLaunchAgainst` (:549-553, :594).
      permissions: ['scheduled-tasks:update'],
      tokenAccess: 'allow',
      summary: 'Replace a scheduled task (arming edits additionally need tasks:execute)',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisible(deps, actor, c.req.param('id'))
      await requireScheduleEdit(deps, actor, existing)
      const rawPatch = await safeJsonOrThrowInvalid(c.req.raw)
      {
        const retired = rejectRetiredStartTaskKeys(
          (rawPatch as { launchPayload?: unknown } | null)?.launchPayload ?? null,
        )
        if (retired !== null) {
          const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
          throw new ValidationError(
            clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
            clientOwnedGitIdentity
              ? `RFC-320 derives Git commit identity from the schedule owner; remove '${retired}' from launchPayload`
              : `RFC-165 retired path-mode launches; remove '${retired}' from launchPayload (push the repo to a real remote and register it, then launch by cachedRepoId)`,
          )
        }
      }
      const parsed = UpdateScheduledTaskSchema.safeParse(rawPatch)
      if (!parsed.success) {
        throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task patch', {
          issues: parsed.error.issues,
        })
      }
      // RFC-324 —— 改名与改绑目标是治理动作（后者等于换执行身份的用途，见
      // requireScheduleGovern 的注释）；节奏与启停留在编辑档。
      if (
        parsed.data.name !== undefined ||
        parsed.data.launchKind !== undefined ||
        parsed.data.launchPayload !== undefined
      ) {
        await requireScheduleGovern(deps, actor, existing)
      }
      const updated = await updateScheduledTask(deps.db, existing.id, parsed.data, {
        actor,
        resourceAuthority: resourceAuthority(c),
        defaultRuntime: loadConfig(deps.configPath).defaultRuntime,
      })
      return c.json(updated)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/scheduled-tasks/:id',
      permissions: ['scheduled-tasks:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a scheduled task',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisible(deps, actor, c.req.param('id'))
      await requireScheduleGovern(deps, actor, existing)
      // RFC-247 T20 — a token must name what it deletes; the web flow keeps its
      // lighter yes/no confirmation (see services/deleteConfirm.ts).
      assertTokenDeleteConfirm(
        await readDeleteBody(c),
        existing.name,
        'scheduled task',
        actor.source,
      )
      captureDeleteSnapshot(c, actor, existing)
      await deleteScheduledTask(deps.db, existing.id)
      return c.body(null, 204)
    },
  )

  // T7 — manual "run now": fire immediately, independent of the schedule cadence
  // (does NOT touch next_run_at / last_* / streak). Owner/admin only. Works even on
  // a disabled schedule (manual override). Launch failures surface as HTTP errors.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/scheduled-tasks/:id/run-now',
      permissions: ['scheduled-tasks:execute', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Run a scheduled task immediately',
    },
    async (c) => {
      // RFC-165 (N1-r3): run-now IS a launch.
      requireLaunchPermission(actorOf(c))
      const actor = actorOf(c)
      const existing = await loadVisible(deps, actor, c.req.param('id'))
      // RFC-324 —— run-now 触发的是 owner 已经选定的目标，属于「推动」而不是
      // 「改绑」，因此归编辑档；改目标仍需 owner（requireScheduleGovern）。
      await requireScheduleEdit(deps, actor, existing)
      const launch =
        deps.buildScheduleLaunch ??
        buildScheduleLaunch(
          deps.db,
          requireSchedulerDriver(deps.schedulerDriver),
          deps.configPath,
          deps.identityAccess,
        )
      const result = await runScheduleNow(
        deps.db,
        existing.id,
        launch,
        deps.identityAccess,
        loadConfig(deps.configPath).defaultRuntime,
      )
      return c.json(result, 201)
    },
  )

  // RFC-324 §7 —— 定时任务的授权面。与 13 类 ACL 资源的 `/acl` 端点同形，但由本
  // 文件自己挂载而不是走 `mountAclEndpoints`：那个挂载器的键域是 `AclResourceType`
  // （带 visibility / builtin / owner×name 唯一域），定时任务三样都没有。
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/scheduled-tasks/:id/acl',
      permissions: ['scheduled-tasks:read'],
      tokenAccess: 'allow',
      summary: 'Read the grant list of one scheduled task',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisible(deps, actor, c.req.param('id'))
      return c.json(await getScheduleAcl(deps.db, actor, existing))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/scheduled-tasks/:id/acl',
      // RFC-247 D5 —— 与其他 ACL 写面同规矩：token 永远不得改授权。
      permissions: ['scheduled-tasks:update'],
      tokenAccess: 'never',
      summary: 'Replace the grant list of one scheduled task',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisible(deps, actor, c.req.param('id'))
      const parsed = UpdateScheduleAclBodySchema.safeParse(await safeJsonOrThrowInvalid(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('acl-invalid', 'invalid acl payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(await updateScheduleAcl(deps.db, actor, existing, parsed.data))
    },
  )
}
