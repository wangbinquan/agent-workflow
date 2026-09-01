import type { UserPublic } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { resourceGrants, users } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ResourceCatalogAclIdentityReadPort,
  ResourceCatalogAclReadPort,
} from '../application/ports/providerResourceCatalogPersistence'
import { POSTGRESQL_ACL_TABLES } from './postgresqlAclRegistry'
import { runPostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'

export function createPostgresqlResourceAclReadPort(
  db: PostgresqlDatabaseClient,
): ResourceCatalogAclReadPort {
  const port: ResourceCatalogAclReadPort = {
    async readSnapshot(type, resourceId) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const table = POSTGRESQL_ACL_TABLES[type]
        const identity = await transaction
          .select({
            id: table.id,
            ownerUserId: table.ownerUserId,
            visibility: table.visibility,
            aclRevision: table.aclRevision,
          })
          .from(table)
          .where(eq(table.id, resourceId))
          .limit(1)
          .get()
        if (identity === undefined) return null
        const grants = await transaction
          .select({ userId: resourceGrants.userId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(
            and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId)),
          )
          .all()
        const userIds = [
          ...new Set([
            ...(identity.ownerUserId === null ? [] : [identity.ownerUserId]),
            ...grants.map((grant) => grant.userId),
          ]),
        ]
        const userRows =
          userIds.length === 0
            ? []
            : await transaction
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
          grants,
          users: new Map<string, UserPublic>(userRows.map((row) => [row.id, row])),
        }
      })
    },
  }
  return Object.freeze(port)
}

export function createPostgresqlResourceCatalogAclIdentityReadPort(
  db: PostgresqlDatabaseClient,
): ResourceCatalogAclIdentityReadPort {
  const port: ResourceCatalogAclIdentityReadPort = {
    async getOwner(type, id) {
      const table = POSTGRESQL_ACL_TABLES[type]
      const row = await db
        .select({ ownerUserId: table.ownerUserId })
        .from(table)
        .where(eq(table.id, id))
        .limit(1)
        .get()
      return row?.ownerUserId
    },
    async listOwnedNames(type, ownerUserId) {
      const table = POSTGRESQL_ACL_TABLES[type]
      const rows = await db
        .select({ name: table.name })
        .from(table)
        .where(eq(table.ownerUserId, ownerUserId))
        .all()
      return rows.map((row) => row.name)
    },
  }
  return Object.freeze(port)
}
