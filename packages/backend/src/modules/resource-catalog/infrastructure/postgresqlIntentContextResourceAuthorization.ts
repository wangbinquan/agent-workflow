import { and, eq } from 'drizzle-orm'
import { resourceGrants } from '@/db/schema'
import type { IntentContextResourceAuthorizationReadPort } from '../application/ports/intentContextResourceAuthorization'
import { POSTGRESQL_ACL_TABLES } from './postgresqlAclRegistry'
import type { PostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'

/** Bind Intent context identity/grant reads to the caller's current PostgreSQL tx. */
export function createPostgresqlIntentContextResourceAuthorizationReadPort(
  transaction: PostgresqlResourceCatalogTransaction,
): IntentContextResourceAuthorizationReadPort {
  const port: IntentContextResourceAuthorizationReadPort = {
    async loadIdentity(resourceType, resourceId) {
      const table = POSTGRESQL_ACL_TABLES[resourceType]
      const row = await transaction
        .select({
          id: table.id,
          name: table.name,
          ownerUserId: table.ownerUserId,
          visibility: table.visibility,
        })
        .from(table)
        .where(eq(table.id, resourceId))
        .limit(1)
        .get()
      return row === undefined
        ? null
        : Object.freeze({
            resourceType,
            resourceId: row.id,
            name: row.name,
            ownerUserId: row.ownerUserId,
            visibility: row.visibility,
          })
    },
    async loadGrantLevel(resourceType, resourceId, userId) {
      const row = await transaction
        .select({ level: resourceGrants.level })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, resourceType),
            eq(resourceGrants.resourceId, resourceId),
            eq(resourceGrants.userId, userId),
          ),
        )
        .limit(1)
        .get()
      return row?.level ?? null
    },
  }
  return Object.freeze(port)
}
