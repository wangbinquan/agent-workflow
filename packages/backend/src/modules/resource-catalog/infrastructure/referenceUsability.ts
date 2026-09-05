import type { AclResourceType, ResourceAccess, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceGrants } from '@/db/schema'
import { ValidationError } from '@/util/errors'
import {
  hasResourceAclBypass,
  isVisibleRow,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
  type AclRow,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

// RFC-359 W4-D18 —— Workgroup 聚合的 agent 引用可用性判定只剩一份（此前 `sqliteReferenceUsability` /
// `postgresqlReferenceUsability` 各一份）：预检在自己的目录事务里跑，终检绑定调用方的事务；缺失 / 不可见的 id 一律
// 以 `acl-missing-refs` 报出（与合一前 SQLite 路径同形）。

async function grantedAgentIds(
  transaction: ResourceCatalogTransaction,
  actor: ResourceAclActorProjection,
): Promise<ReadonlySet<string>> {
  const rows = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, 'agent'), eq(resourceGrants.userId, actor.user.id)))
  return new Set(rows.map((row) => row.resourceId))
}

async function agentAccessRows(
  transaction: ResourceCatalogTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, AclRow>> {
  if (ids.length === 0) return new Map()
  const rows = await transaction
    .select({
      id: agents.id,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(inArray(agents.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row]))
}

export function assertNoMissingResourceRefs(
  missing: ReadonlyArray<{ readonly type: AclResourceType; readonly name: string }>,
): void {
  if (missing.length === 0) return
  throw new ValidationError(
    'acl-missing-refs',
    `you do not have access to: ${missing.map((item) => `${item.type} '${item.name}'`).join(', ')}`,
    { missing: [...missing] },
  )
}

/** 异步 D15 预检；解析不到的 id 仍归存在性校验器管。 */
export async function resolveAgentIdsUsable(
  db: ProviderNeutralDatabase,
  actor: ResourceAclActorProjection,
  ids: readonly string[],
  grandfatheredIds: ReadonlySet<string>,
): Promise<readonly string[]> {
  const refs = [...new Set(ids)].filter((id) => id.length > 0)
  if (refs.length === 0 || hasResourceAclBypass(actor)) return []
  return runResourceCatalogTransaction(db, async (transaction) => {
    const [rows, granted] = await Promise.all([
      agentAccessRows(transaction, refs),
      grantedAgentIds(transaction, actor),
    ])
    return refs.filter((id) => {
      const row = rows.get(id)
      return row !== undefined && !grandfatheredIds.has(id) && !isVisibleRow(actor, row, granted)
    })
  })
}

/** 同一事务里的 D15 终检；匹配后被删的 id 按不可用处理（fail closed）。 */
export async function assertAgentIdsUsableInTransaction(
  transaction: ResourceCatalogTransaction,
  actor: ResourceAclActorProjection,
  ids: readonly string[],
): Promise<readonly string[]> {
  const refs = [...new Set(ids)].filter((id) => id.length > 0)
  if (refs.length === 0 || hasResourceAclBypass(actor)) return []
  const [rows, granted] = await Promise.all([
    agentAccessRows(transaction, refs),
    grantedAgentIds(transaction, actor),
  ])
  return refs.filter((id) => {
    const row = rows.get(id)
    return row === undefined || !isVisibleRow(actor, row, granted)
  })
}

export async function resolveAccessInTransaction(
  transaction: ResourceCatalogTransaction,
  actor: ResourceAclActorProjection,
  type: 'workgroup',
  row: AclRow,
): Promise<ResourceAccess> {
  const audience = resourceAclAudienceAuthority(actor)
  let grant: ResourceGrantLevel | null = null
  if (!audience.bypass && audience.private) {
    const result = (
      await transaction
        .select({ level: resourceGrants.level })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, type),
            eq(resourceGrants.resourceId, row.id),
            eq(resourceGrants.userId, actor.user.id),
          ),
        )
        .limit(1)
    )[0]
    grant = result?.level ?? null
  }
  return resolveAccessFrom(audience, actor.user.id, row, grant)
}

export async function listGrantedUserIdsInTransaction(
  transaction: ResourceCatalogTransaction,
  type: 'workgroup',
  resourceId: string,
): Promise<readonly string[]> {
  const rows = await transaction
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId)))
  return rows.map((row) => row.userId)
}
