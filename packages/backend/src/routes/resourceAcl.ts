// RFC-099 — generic GET/PUT /api/{resource}/:key/acl endpoints, mounted once
// per resource by the five resource route modules. Both routes declare their
// own coarse gate below (GET→`{res}:read`, PUT→`{res}:update`); per-row owner
// enforcement happens in updateResourceAcl.
//
// "Row missing" and "row invisible" deliberately produce the SAME 404 payload
// so a non-granted user cannot probe existence (D1).

import {
  UpdateResourceAclBodySchema,
  type AclResourceType,
  type ResourceAcl,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import type { DbTxSync } from '@/db/txSync'
import {
  canViewResource,
  getResourceAcl,
  updateResourceAcl,
  type AclRow,
} from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { NotFoundError, ValidationError } from '@/util/errors'

/**
 * 挂载配置的键域 = 全部 `AclResourceType`，**没有排除项**。
 *
 * RFC-317 T66 —— 这段注释此前写着「RFC-310 的五类数字员工配置资源已进
 * AclResourceType…挂载配置的键域显式排除它们——等对应 routes 批次落地时从这里
 * 移除排除项」，而紧接着的一行就是 `= AclResourceType`：排除项**早已不存在**，
 * 那五类的 ACL 端点也早已挂上（`routes/developmentConfig.ts` 的
 * `mountAclEndpoints`）。这是最坏的一种过期断言——它读起来像一件**待办**，
 * 会让下一个人去找一个不存在的排除清单，或者以为那五类还没有 ACL 端点而重复实现。
 *
 * 保留这个别名而不是直接用 `AclResourceType`：`ACL_PERMISSION_PREFIX` 用它做
 * `Record` 键域，新增一类 ACL 资源时编译器会在那里报错，逼出「这一类的权限点
 * 前缀是什么」这个决策（RFC-317 B1-c 的 `employee_definition` 就是被它逼出来的）。
 */
export type MountedAclResourceType = AclResourceType

export interface AclEndpointConfig {
  type: MountedAclResourceType
  /** e.g. '/api/agents' */
  base: string
  /** RFC-223: every ACL route is addressed by canonical resource id. */
  param: 'id'
  /** Load the row by the route key; null when absent. */
  load: (db: AppDeps['db'], key: string) => Promise<AclRow | null>
  /** RFC-201: optional stable-id linearization adapter for operation resources. */
  coordinator?: {
    runExclusive: (resourceId: string, task: () => Promise<ResourceAcl>) => Promise<ResourceAcl>
    loadById: (db: AppDeps['db'], resourceId: string) => Promise<AclRow | null>
    nextUpdatedAt?: (row: AclRow) => Promise<number>
  }
  /** Post-commit resource-specific lifecycle invalidation hook. */
  afterUpdate?: (resourceId: string) => void | Promise<void>
  /** Durable resource-specific invalidation committed atomically with the ACL write. */
  afterWriteInTx?: (
    tx: DbTxSync,
    change: {
      resourceId: string
      ownerUserId: string | null
      visibility: 'public' | 'private'
      grantedUserIds: ReadonlySet<string>
      now: number
    },
  ) => void
}

export function mountAclEndpoints(app: Hono, deps: AppDeps, cfg: AclEndpointConfig): void {
  const path = `${cfg.base}/:${cfg.param}/acl`
  // RFC-247 T1/T3 — the GET/PUT pair here is generated from a template, so
  // there is no literal path for a caller to declare. The mount registers its
  // OWN metadata instead: leaving it to each caller would mean one chance per
  // caller to write a different contract for the same endpoint, and the
  // startup coverage self-check could not tell a missing declaration from a
  // templated one.
  // (RFC-317 T66 — this comment used to say "these twelve routes (six
  // resources x GET/PUT)" and "the six callers". Both counts were frozen at
  // RFC-247 time; the mount has more callers than that today and the sentence
  // never depended on the number. Counting call sites in prose is a ledger
  // nobody updates — the derived truth is `ACL_RESOURCE_TYPES` plus whichever
  // route files call this function.)
  // Exhaustive singular→plural map rather than a cast off `cfg.base`: adding a
  // new ACL resource type becomes a COMPILE error here instead of silently
  // producing a permission point that no route backs (which the RFC-247 startup
  // reverse check would then reject at boot, much further from the cause).
  // Value type is the ACL prefixes only — deliberately not MatrixResource,
  // which also contains repos / tasks / memory / scheduled-tasks. Widening it
  // would let `${resource}:update` name `repos:update`, a point RFC-247 never
  // created because the repos domain has no PUT/PATCH route. TypeScript catches
  // that today; keeping the narrow type means it keeps catching it.
  const ACL_PERMISSION_PREFIX: Record<
    MountedAclResourceType,
    | 'agents'
    | 'skills'
    | 'mcps'
    | 'plugins'
    | 'workflows'
    | 'workgroups'
    | 'capability-templates'
    | 'action-templates'
    | 'verification-profiles'
    | 'digital-employees'
    | 'automation-policies'
    | 'adapter-definitions'
  > = {
    agent: 'agents',
    skill: 'skills',
    mcp: 'mcps',
    plugin: 'plugins',
    workflow: 'workflows',
    workgroup: 'workgroups',
    capability_template: 'capability-templates',
    // RFC-310 —— 数字员工配置五资源。
    action_template: 'action-templates',
    verification_profile: 'verification-profiles',
    digital_employee: 'digital-employees',
    automation_policy: 'automation-policies',
    development_adapter: 'adapter-definitions',
    // RFC-317 T8 —— 用户裁决：复用既有的 digital-employees:* 前缀，不新开点族。
    // 于是这个前缀同时背两样东西：RFC-310 的 digital_employee **配置资源**
    // （/api/code/digital-employees）与 OS 的员工定义（/api/digital-employees）。
    // 语义上确实混淆，但新开点族要动权限目录 / 角色 preset / 目录顺序表 /
    // 存量 grant 与 PAT scope 迁移，属独立的产品变更（findings.md TP-05 同类）。
    employee_definition: 'digital-employees',
  }
  const resource = ACL_PERMISSION_PREFIX[cfg.type]

  registerRoute(
    app,
    {
      method: 'GET',
      path,
      permissions: [`${resource}:read`],
      tokenAccess: 'allow',
      summary: `Read the ACL of one ${cfg.type}`,
    },
    async (c) => {
      const key = c.req.param(cfg.param) ?? ''
      const actor = actorOf(c)
      const row = await cfg.load(deps.db, key)
      if (row === null || !(await canViewResource(deps.db, actor, cfg.type, row))) {
        throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} not found`)
      }
      return c.json(await getResourceAcl(deps.db, actor, cfg.type, row))
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path,
      // RFC-247 D5 — a token must NEVER change owner / grants / visibility.
      // This is the invariant's canonical URL shape; three more carry the same
      // rule (PUT /api/tasks/:id/members, PUT /api/workgroup-tasks/:taskId/config,
      // POST /api/tasks/:id/questions/:entryId/reassign).
      permissions: [`${resource}:update`],
      tokenAccess: 'never',
      summary: `Replace the ACL of one ${cfg.type}`,
    },
    async (c) => {
      const key = c.req.param(cfg.param) ?? ''
      const actor = actorOf(c)
      const row = await cfg.load(deps.db, key)
      if (row === null || !(await canViewResource(deps.db, actor, cfg.type, row))) {
        throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} not found`)
      }
      const body: unknown = await c.req.json().catch(() => ({}))
      const parsed = UpdateResourceAclBodySchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('acl-invalid', 'invalid acl payload', {
          issues: parsed.error.issues,
        })
      }
      const updateFresh = async (fresh: AclRow): Promise<ResourceAcl> => {
        if (!(await canViewResource(deps.db, actor, cfg.type, fresh))) {
          throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} not found`)
        }
        // RFC-104: built-ins are read-only. This runs on the in-lock fresh row.
        assertNotBuiltin(cfg.type, fresh)
        const updatedAt = await cfg.coordinator?.nextUpdatedAt?.(fresh)
        return updateResourceAcl(deps.db, actor, cfg.type, fresh, parsed.data, {
          updatedAt,
          afterWriteInTx: cfg.afterWriteInTx,
        })
      }
      const result =
        cfg.coordinator === undefined
          ? await updateFresh(row)
          : await cfg.coordinator.runExclusive(row.id, async () => {
              const fresh = await cfg.coordinator!.loadById(deps.db, row.id)
              if (fresh === null) {
                throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} not found`)
              }
              return updateFresh(fresh)
            })
      // RFC-317 T29（ACL-04）—— 每类资源「ACL 改完之后还要做什么」由**它自己的**
      // 挂载配置给出。这里原本按 `cfg.type === 'workflow' | 'workgroup'` 分叉发广播：
      // 一个服务全部 ACL 资源的通用挂载器，凭空认识了其中两类，第三类要发广播就只能
      // 回来再加一条 if——而 `afterUpdate` 这个钩子当时就已经在了，两条分支纯属没走它。
      await cfg.afterUpdate?.(row.id)
      return c.json(result)
    },
  )
}
