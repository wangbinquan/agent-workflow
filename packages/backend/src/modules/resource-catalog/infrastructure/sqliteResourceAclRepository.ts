import type { AclResourceType, UserPublic } from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type NotPromise } from '@/db/txSync'
import { resourceGrants, users } from '@/db/schema'
import type {
  ResourceAclMutationContext,
  ResourceAclMutationRow,
} from '../application/ports/resourceAclPersistence'
import {
  SQLITE_ACL_TABLES,
  SQLITE_OWNER_NAME_UNIQUE_TYPES,
  sqliteOwnerNamePartitionOf,
} from './sqliteAclRegistry'
import { grantsOfResourceWhere } from './sqliteResourceGrantRepository'

export async function getSqliteResourceAclRevision(
  db: DbClient,
  type: AclResourceType,
  resourceId: string,
): Promise<number> {
  const table = SQLITE_ACL_TABLES[type]
  const rows = await db
    .select({ aclRevision: table.aclRevision })
    .from(table)
    .where(eq(table.id, resourceId))
    .limit(1)
  return rows[0]?.aclRevision ?? 0
}

export async function loadAclUsers(
  db: DbClient,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, UserPublic>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select()
    .from(users)
    .where(inArray(users.id, [...userIds]))
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
      },
    ]),
  )
}

/**
 * Opens the one synchronous ACL write transaction while keeping every
 * resource table/column handle inside infrastructure.
 */
export function withSqliteResourceAclMutation<T>(
  db: DbClient,
  type: AclResourceType,
  resourceId: string,
  run: (context: ResourceAclMutationContext) => NotPromise<T>,
): T | undefined {
  const table = SQLITE_ACL_TABLES[type]
  const partition = sqliteOwnerNamePartitionOf(type)
  return dbTxSync<unknown>(db, (tx) => {
    const raw = tx
      .select({
        aclRevision: table.aclRevision,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
        ...partition,
      })
      .from(table)
      .where(eq(table.id, resourceId))
      .get() as (ResourceAclMutationRow & Record<string, unknown>) | undefined
    if (raw === undefined) return undefined

    const current: ResourceAclMutationRow = {
      id: resourceId,
      name: raw.name,
      ownerUserId: raw.ownerUserId ?? null,
      visibility: raw.visibility ?? 'public',
      aclRevision: raw.aclRevision,
    }

    return run({
      tx,
      current,
      ownerNameIsUnique: SQLITE_OWNER_NAME_UNIQUE_TYPES.has(type),
      hasOwnerNameCollision(nextOwnerUserId) {
        if (!SQLITE_OWNER_NAME_UNIQUE_TYPES.has(type)) return false
        return (
          tx
            .select({ id: table.id })
            .from(table)
            .where(
              and(
                eq(table.ownerUserId, nextOwnerUserId),
                eq(table.name, current.name),
                ne(table.id, resourceId),
                ...Object.entries(partition).map(([key, column]) => eq(column, raw[key])),
              ),
            )
            .get() !== undefined
        )
      },
      activeUserIds(userIds) {
        if (userIds.length === 0) return new Set()
        const rows = tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(inArray(users.id, [...userIds]))
          .all()
        return new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
      },
      updateAclRow(input) {
        tx.update(table)
          .set({
            ownerUserId: input.ownerUserId,
            visibility: input.visibility,
            aclRevision: input.aclRevision,
            updatedAt: input.updatedAt,
          })
          .where(eq(table.id, resourceId))
          .run()
      },
      replaceGrants(grants, addedBy, addedAt) {
        tx.delete(resourceGrants).where(grantsOfResourceWhere(type, resourceId)).run()
        if (grants.size === 0) return
        tx.insert(resourceGrants)
          .values(
            [...grants].map(([userId, level]) => ({
              resourceType: type,
              resourceId,
              userId,
              level,
              addedBy,
              addedAt,
            })),
          )
          .run()
      },
    })
  }) as T | undefined
}

export function isSqliteOwnerNameConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)
}
