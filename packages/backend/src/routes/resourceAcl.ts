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
import {
  WORKFLOWS_CHANNEL,
  WORKGROUPS_CHANNEL,
  workflowsBroadcaster,
  workgroupsBroadcaster,
} from '@/ws/broadcaster'

/**
 * RFC-310 的五类数字员工配置资源已进 AclResourceType，但它们的 ACL 端点与
 * permission 点必须同批落（registry.ts 的 RFC-247 反向自检：无 route 的点
 * 会让 daemon 拒启）。挂载配置的键域显式排除它们——等对应 routes 批次落地
 * 时从这里移除排除项，编译器会顺带要求补 ACL_PERMISSION_PREFIX 映射。
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
  // RFC-247 T1/T3 — these twelve routes (six resources x GET/PUT) are generated
  // from a template, so there is no literal path for a caller to declare. The
  // mount registers its OWN metadata instead: leaving it to the six callers
  // would mean six chances to write a different contract for the same endpoint,
  // and the startup coverage self-check could not tell a missing declaration
  // from a templated one.
  // Exhaustive singular→plural map rather than a cast off `cfg.base`: adding a
  // seventh ACL resource type becomes a COMPILE error here instead of silently
  // producing a permission point that no route backs (which the RFC-247 startup
  // reverse check would then reject at boot, much further from the cause).
  // Value type is the SIX ACL prefixes only — deliberately not MatrixResource,
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
      await cfg.afterUpdate?.(row.id)
      if (cfg.type === 'workflow') {
        // Lets connected /ws/workflows clients re-fetch AND lets the WS server
        // invalidate its per-connection visibility cache for this workflow.
        workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
          type: 'workflow.acl.updated',
          workflowId: row.id,
        })
      }
      if (cfg.type === 'workgroup') {
        workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
          type: 'workgroup.acl.updated',
          workgroupId: row.id,
        })
      }
      return c.json(result)
    },
  )
}
