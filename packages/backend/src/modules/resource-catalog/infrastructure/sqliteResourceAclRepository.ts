import type {
  AclResourceType,
  ResourceGrantLevel,
  ResourceVisibility,
  UserPublic,
} from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync, type NotPromise } from '@/db/txSync'
import { resourceGrants, users } from '@/db/schema'
import type {
  ResourceAclIdentityMutation,
  ResourceAclIdentityPersistence,
} from '../application/ports/resourceAclPersistence'
import type {
  ResourceCatalogAclMutationChange,
  ResourceCatalogAclMutationPort,
  ResourceCatalogAclReadPort,
} from '../application/ports/providerResourceCatalogPersistence'
import type { AclRow } from '../domain/resourceAccess'
import {
  isSqliteAclResourceType,
  SQLITE_ACL_TABLES,
  SQLITE_OWNER_NAME_UNIQUE_TYPES,
  sqliteOwnerNamePartitionOf,
} from './sqliteAclRegistry'
import { grantsOfResourceWhere, listResourceGrantsInTx } from './sqliteResourceGrantRepository'

interface SqliteResourceAclMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly aclRevision: number
}

interface SqliteResourceAclMutationContext {
  readonly tx: DbTxSync
  readonly current: SqliteResourceAclMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): boolean
  activeUserIds(userIds: readonly string[]): ReadonlySet<string>
  updateAclRow(input: {
    readonly ownerUserId: string | null
    readonly visibility: ResourceVisibility
    readonly aclRevision: number
    readonly updatedAt: number
  }): void
  replaceGrants(
    grants: ReadonlyMap<string, ResourceGrantLevel>,
    addedBy: string,
    addedAt: number,
  ): void
}

export async function getSqliteResourceAclRevision(
  db: DbClient,
  type: AclResourceType,
  resourceId: string,
  identityPersistence?: ResourceAclIdentityPersistence,
): Promise<number> {
  if (identityPersistence !== undefined) {
    if (identityPersistence.type !== type) {
      throw new Error(
        `ACL identity persistence type ${identityPersistence.type} cannot serve ${type}`,
      )
    }
    return identityPersistence.getRevision(resourceId)
  }
  if (!isSqliteAclResourceType(type)) {
    throw new Error(`ACL identity persistence is required for ${type}`)
  }
  const table = SQLITE_ACL_TABLES[type]
  const rows = await db
    .select({ aclRevision: table.aclRevision })
    .from(table)
    .where(eq(table.id, resourceId))
    .limit(1)
  return rows[0]?.aclRevision ?? 0
}

function runResourceAclMutation<T>(
  tx: DbTxSync,
  type: AclResourceType,
  resourceId: string,
  identity: ResourceAclIdentityMutation,
  run: (context: SqliteResourceAclMutationContext) => NotPromise<T>,
): T {
  return run({
    tx,
    current: identity.current,
    ownerNameIsUnique: identity.ownerNameIsUnique,
    hasOwnerNameCollision: (nextOwnerUserId) => identity.hasOwnerNameCollision(nextOwnerUserId),
    activeUserIds(userIds) {
      if (userIds.length === 0) return new Set()
      const rows = tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(inArray(users.id, [...userIds]))
        .all()
      return new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
    },
    updateAclRow: (input) => identity.update(input),
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
  identityPersistence: ResourceAclIdentityPersistence | undefined,
  run: (context: SqliteResourceAclMutationContext) => NotPromise<T>,
): T | undefined {
  if (identityPersistence !== undefined) {
    if (identityPersistence.type !== type) {
      throw new Error(
        `ACL identity persistence type ${identityPersistence.type} cannot serve ${type}`,
      )
    }
    return identityPersistence.withMutation(resourceId, (identity) => {
      // The provider owns dbTxSync on this same synchronous SQLite connection.
      // Using the root Drizzle handle here still executes inside that active
      // transaction, so identity, users and grants commit or roll back together.
      const tx = db as unknown as DbTxSync
      return runResourceAclMutation(tx, type, resourceId, identity, run)
    })
  }
  if (!isSqliteAclResourceType(type)) {
    throw new Error(`ACL identity persistence is required for ${type}`)
  }
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
      .get() as (SqliteResourceAclMutationRow & Record<string, unknown>) | undefined
    if (raw === undefined) return undefined

    const current: SqliteResourceAclMutationRow = {
      id: resourceId,
      name: raw.name,
      ownerUserId: raw.ownerUserId ?? null,
      visibility: raw.visibility ?? 'public',
      aclRevision: raw.aclRevision,
    }

    return runResourceAclMutation(
      tx,
      type,
      resourceId,
      {
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
        update(input) {
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
      },
      run,
    )
  }) as T | undefined
}

export function isSqliteOwnerNameConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)
}

export function createSqliteResourceAclReadPort(
  db: DbClient,
  identityPersistence?: ResourceAclIdentityPersistence,
): ResourceCatalogAclReadPort<AclResourceType> {
  const port: ResourceCatalogAclReadPort<AclResourceType> = {
    async readSnapshot(type, resourceId, fallbackIdentity) {
      return dbTxSync(db, (transaction) => {
        let identity: AclRow & { readonly aclRevision: number }
        if (identityPersistence !== undefined) {
          if (identityPersistence.type !== type) {
            throw new Error(
              `ACL identity persistence type ${identityPersistence.type} cannot serve ${type}`,
            )
          }
          identity = {
            ...fallbackIdentity,
            aclRevision: identityPersistence.getRevision(resourceId),
          }
        } else {
          if (!isSqliteAclResourceType(type)) {
            throw new Error(`ACL identity persistence is required for ${type}`)
          }
          const table = SQLITE_ACL_TABLES[type]
          const row = transaction
            .select({
              id: table.id,
              ownerUserId: table.ownerUserId,
              visibility: table.visibility,
              aclRevision: table.aclRevision,
            })
            .from(table)
            .where(eq(table.id, resourceId))
            .get()
          if (row === undefined) return null
          identity = row
        }
        const grants = listResourceGrantsInTx(transaction, type, resourceId)
        const userIds = [
          ...new Set([
            ...(typeof identity.ownerUserId === 'string' ? [identity.ownerUserId] : []),
            ...grants.keys(),
          ]),
        ]
        const userRows =
          userIds.length === 0
            ? []
            : transaction
                .select({
                  id: users.id,
                  username: users.username,
                  displayName: users.displayName,
                  role: users.role,
                  status: users.status,
                })
                .from(users)
                .where(inArray(users.id, userIds))
                .all()
        return {
          identity: {
            id: identity.id,
            ownerUserId: identity.ownerUserId,
            visibility: identity.visibility,
          },
          aclRevision: identity.aclRevision,
          grants: [...grants].map(([userId, level]) => ({ userId, level })),
          users: new Map<string, UserPublic>(userRows.map((row) => [row.id, row])),
        }
      })
    },
  }
  return Object.freeze(port)
}

export interface SqliteResourceAclMutationLifecycle {
  afterWriteInTransaction?(
    transaction: DbTxSync,
    change: ResourceCatalogAclMutationChange<AclResourceType>,
  ): void
}

/**
 * Provider-bound Promise port for resource-catalog-owned ACL rows.  The
 * synchronous SQLite transaction and table registry remain private to this
 * adapter; application code receives only a complete decision snapshot.
 */
export function createSqliteResourceAclMutationPort(
  db: DbClient,
  lifecycle: SqliteResourceAclMutationLifecycle = {},
  identityPersistence?: ResourceAclIdentityPersistence,
): ResourceCatalogAclMutationPort<AclResourceType> {
  const port: ResourceCatalogAclMutationPort<AclResourceType> = {
    async mutate(request, decide) {
      return withSqliteResourceAclMutation(
        db,
        request.type,
        request.resourceId,
        identityPersistence,
        (context) => {
          const currentGrants = listResourceGrantsInTx(context.tx, request.type, request.resourceId)
          const candidateOwner = request.candidateOwnerUserId
          const decision = decide({
            current: context.current,
            ownerNameIsUnique: context.ownerNameIsUnique,
            ownerNameCollision:
              typeof candidateOwner === 'string' && context.hasOwnerNameCollision(candidateOwner),
            activeUserIds: context.activeUserIds(request.referencedUserIds),
            currentGrants,
            actorGrantLevel: currentGrants.get(request.actorUserId) ?? null,
          })
          context.updateAclRow(decision.update)
          context.replaceGrants(decision.grants, decision.addedBy, decision.addedAt)
          lifecycle.afterWriteInTransaction?.(context.tx, {
            type: request.type,
            resourceId: request.resourceId,
            ownerUserId: decision.update.ownerUserId,
            visibility: decision.update.visibility,
            aclRevision: decision.update.aclRevision,
            grantedUserIds: new Set(decision.grants.keys()),
            now: decision.update.updatedAt,
          })
          return decision.result
        },
      )
    },
    isOwnerNameConstraintError: isSqliteOwnerNameConstraintError,
  }
  return Object.freeze(port)
}
