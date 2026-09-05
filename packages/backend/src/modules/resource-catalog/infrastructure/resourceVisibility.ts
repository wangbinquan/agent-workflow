// RFC-359 W4-B2 —— 目录资源的 ACL 表注册 + 可见性谓词 + grant 读端口：一份实现，两个 provider 共用。
//
// 此前 `sqliteAclRegistry` / `postgresqlAclRegistry` 各登记一份逐字相同的表注册，
// `sqliteResourceGrantRepository` / `postgresqlResourceGrantRepository` 各写一份逐字相同的可见性阶梯 SQL。
// 这里是唯一的一份；SQLite 侧仍保留给 legacy 同步调用方的 `*InTx` 读法（dbTxSync 归零时删）。

import type { AclResourceType, GrantResourceType, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  actionTemplates,
  agents,
  automationPolicies,
  capabilityTemplates,
  digitalEmployees,
  mcps,
  plugins,
  resourceGrants,
  skills,
  verificationProfiles,
  workflows,
  workgroups,
} from '@/db/schema'
import type {
  ResourceCatalogGrantReadPort,
  ResourceCatalogOwnedAclType,
} from '../application/ports/providerResourceCatalogPersistence'
import {
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'

/** RFC-345 D4 —— canonical ACL roster 的表注册（两个 provider 共用同一张逻辑表清单）。 */
export const ACL_TABLES = {
  agent: agents,
  skill: skills,
  mcp: mcps,
  plugin: plugins,
  workflow: workflows,
  workgroup: workgroups,
  capability_template: capabilityTemplates,
  action_template: actionTemplates,
  verification_profile: verificationProfiles,
  digital_employee: digitalEmployees,
  automation_policy: automationPolicies,
} as const satisfies Readonly<Record<ResourceCatalogOwnedAclType, object>>

export type AclTableFor<K extends ResourceCatalogOwnedAclType> = (typeof ACL_TABLES)[K]

/** The canonical grant-set predicate, shared by async and in-transaction reads. */
export function grantsOfUserWhere(type: GrantResourceType, userId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, userId))
}

/** The canonical by-resource predicate, shared by audience and ACL reads. */
export function grantsOfResourceWhere(type: GrantResourceType, resourceId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId))
}

/** Column handles accepted by the count-only visibility projection. */
export interface AclColumnRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

/** SQL twin of the domain visibility ladder for count-only surfaces. */
export function visibleRowsCondition(
  db: ProviderNeutralDatabase,
  actor: ResourceAclActorProjection,
  type: AclResourceType,
  cols: AclColumnRef,
): SQL<unknown> | undefined {
  if (hasResourceAclBypass(actor)) return undefined
  const isPublic = sql`COALESCE(${cols.visibility}, 'public') = 'public'`
  if (!hasPrivateResourceAccess(actor)) return isPublic
  const granted = inArray(
    cols.id,
    db
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(grantsOfUserWhere(type, actor.user.id)),
  )
  return or(isPublic, sql`${cols.ownerUserId} = ${actor.user.id}`, granted)!
}

/** Promise-shaped grant reads used by the composition root on both providers. */
export function createResourceGrantReadPort(
  db: ProviderNeutralDatabase,
): ResourceCatalogGrantReadPort {
  const port: ResourceCatalogGrantReadPort = {
    async listGrantedResourceIds(actor, type) {
      const rows = await db
        .select({ resourceId: resourceGrants.resourceId })
        .from(resourceGrants)
        .where(grantsOfUserWhere(type, actor.user.id))
      return new Set(rows.map((row) => row.resourceId))
    },
    async loadGrantLevel(type, resourceId, userId) {
      const rows = await db
        .select({ level: resourceGrants.level })
        .from(resourceGrants)
        .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
        .limit(1)
      return rows[0]?.level ?? null
    },
    async loadGrantLevelsForUser(type, resourceIds, userId) {
      const out = new Map<string, ResourceGrantLevel>()
      for (let index = 0; index < resourceIds.length; index += 500) {
        const chunk = resourceIds.slice(index, index + 500)
        const rows = await db
          .select({ resourceId: resourceGrants.resourceId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(and(grantsOfUserWhere(type, userId), inArray(resourceGrants.resourceId, chunk)))
        for (const row of rows) out.set(row.resourceId, row.level)
      }
      return out
    },
  }
  return Object.freeze(port)
}
