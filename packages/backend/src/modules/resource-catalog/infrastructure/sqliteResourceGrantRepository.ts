import type { AclResourceType, GrantResourceType, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { resourceGrants } from '@/db/schema'
import {
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'

/** The canonical grant-set predicate, shared by async and in-transaction reads. */
export function grantsOfUserWhere(type: GrantResourceType, userId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, userId))
}

/** The canonical by-resource predicate, shared by audience and ACL reads. */
export function grantsOfResourceWhere(type: GrantResourceType, resourceId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId))
}

export async function listGrantedResourceIds(
  db: DbClient,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
  return new Set(rows.map((row) => row.resourceId))
}

export function listGrantedResourceIdsInTx(
  tx: DbTxSync,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Set<string> {
  const rows = tx
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(grantsOfUserWhere(type, actor.user.id))
    .all()
  return new Set(rows.map((row) => row.resourceId))
}

export async function listResourceGrantUserIds(
  db: DbClient,
  type: GrantResourceType,
  resourceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
  return rows.map((row) => row.userId)
}

export async function listResourceGrants(
  db: DbClient,
  type: GrantResourceType,
  resourceId: string,
): Promise<Array<{ userId: string; level: ResourceGrantLevel }>> {
  return db
    .select({ userId: resourceGrants.userId, level: resourceGrants.level })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
}

export function listResourceGrantsInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
): Map<string, ResourceGrantLevel> {
  return new Map(
    tx
      .select({ userId: resourceGrants.userId, level: resourceGrants.level })
      .from(resourceGrants)
      .where(grantsOfResourceWhere(type, resourceId))
      .all()
      .map((row) => [row.userId, row.level] as const),
  )
}

export function listResourceGrantUserIdsInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
): string[] {
  return tx
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(grantsOfResourceWhere(type, resourceId))
    .all()
    .map((row) => row.userId)
}

export async function listWritableGrantedResourceIds(
  db: DbClient,
  actor: ResourceAclActorProjection,
  type: GrantResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(grantsOfUserWhere(type, actor.user.id), eq(resourceGrants.level, 'write')))
  return new Set(rows.map((row) => row.resourceId))
}

export async function loadGrantLevel(
  db: DbClient,
  type: GrantResourceType,
  resourceId: string,
  userId: string,
): Promise<ResourceGrantLevel | null> {
  const rows = await db
    .select({ level: resourceGrants.level })
    .from(resourceGrants)
    .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
    .limit(1)
  return rows[0]?.level ?? null
}

export function loadGrantLevelInTx(
  tx: DbTxSync,
  type: GrantResourceType,
  resourceId: string,
  userId: string,
): ResourceGrantLevel | null {
  return (
    tx
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
      .get()?.level ?? null
  )
}

export async function loadGrantLevelsForUser(
  db: DbClient,
  type: GrantResourceType,
  resourceIds: readonly string[],
  userId: string,
): Promise<Map<string, ResourceGrantLevel>> {
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
}

/** Column handles accepted by the count-only visibility projection. */
export interface AclColumnRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

/** SQL twin of the domain visibility ladder for count-only surfaces. */
export function visibleRowsCondition(
  db: DbClient,
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
