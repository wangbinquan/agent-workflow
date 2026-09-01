import { and, eq, inArray, ne } from 'drizzle-orm'
import { resourceGrants, users } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError } from '@/util/errors'
import type {
  ResourceCatalogAclMutationChange,
  ResourceCatalogAclMutationPort,
} from '../application/ports/providerResourceCatalogPersistence'
import {
  POSTGRESQL_ACL_TABLES,
  POSTGRESQL_OWNER_NAME_UNIQUE_CONSTRAINTS,
  POSTGRESQL_OWNER_NAME_UNIQUE_TYPES,
} from './postgresqlAclRegistry'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

export interface PostgresqlResourceAclMutationLifecycle {
  afterWriteInTransaction?(
    transaction: PostgresqlResourceCatalogTransaction,
    change: ResourceCatalogAclMutationChange,
  ): Promise<void>
}

/**
 * PostgreSQL's complete ACL mutation boundary.  Serializable retry, the
 * provider-specific transaction handle and concrete table roster never cross
 * into application code.
 */
export function createPostgresqlResourceAclMutationPort(
  db: PostgresqlDatabaseClient,
  lifecycle: PostgresqlResourceAclMutationLifecycle = {},
): ResourceCatalogAclMutationPort {
  const port: ResourceCatalogAclMutationPort = {
    async mutate(request, decide) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const table = POSTGRESQL_ACL_TABLES[request.type]
        const current = await transaction
          .select({
            id: table.id,
            name: table.name,
            ownerUserId: table.ownerUserId,
            visibility: table.visibility,
            aclRevision: table.aclRevision,
          })
          .from(table)
          .where(eq(table.id, request.resourceId))
          .limit(1)
          .get()
        if (current === undefined) return undefined

        const grantRows = await transaction
          .select({ userId: resourceGrants.userId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, request.type),
              eq(resourceGrants.resourceId, request.resourceId),
            ),
          )
          .all()
        const currentGrants = new Map(
          grantRows.map((grant) => [grant.userId, grant.level] as const),
        )

        const activeRows =
          request.referencedUserIds.length === 0
            ? []
            : await transaction
                .select({ id: users.id })
                .from(users)
                .where(
                  and(
                    inArray(users.id, [...request.referencedUserIds]),
                    eq(users.status, 'active'),
                  ),
                )
                .all()
        const candidateOwner = request.candidateOwnerUserId
        const ownerNameIsUnique = POSTGRESQL_OWNER_NAME_UNIQUE_TYPES.has(request.type)
        const collision =
          typeof candidateOwner === 'string' && ownerNameIsUnique
            ? await transaction
                .select({ id: table.id })
                .from(table)
                .where(
                  and(
                    eq(table.ownerUserId, candidateOwner),
                    eq(table.name, current.name),
                    ne(table.id, request.resourceId),
                  ),
                )
                .limit(1)
                .get()
            : undefined
        const decision = decide({
          current,
          ownerNameIsUnique,
          ownerNameCollision: collision !== undefined,
          activeUserIds: new Set(activeRows.map((row) => row.id)),
          currentGrants,
          actorGrantLevel: currentGrants.get(request.actorUserId) ?? null,
        })

        const updated = await transaction
          .update(table)
          .set(decision.update)
          .where(and(eq(table.id, request.resourceId), eq(table.aclRevision, current.aclRevision)))
          .returning({ id: table.id })
          .get()
        if (updated === undefined) {
          throw new ConflictError(
            'acl-revision-conflict',
            'resource ACL changed while saving; reload and retry',
          )
        }

        await transaction
          .delete(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, request.type),
              eq(resourceGrants.resourceId, request.resourceId),
            ),
          )
          .run()
        if (decision.grants.size > 0) {
          await transaction
            .insert(resourceGrants)
            .values(
              [...decision.grants].map(([userId, level]) => ({
                resourceType: request.type,
                resourceId: request.resourceId,
                userId,
                level,
                addedBy: decision.addedBy,
                addedAt: decision.addedAt,
              })),
            )
            .run()
        }

        await lifecycle.afterWriteInTransaction?.(transaction, {
          type: request.type,
          resourceId: request.resourceId,
          ownerUserId: decision.update.ownerUserId,
          visibility: decision.update.visibility,
          aclRevision: decision.update.aclRevision,
          grantedUserIds: new Set(decision.grants.keys()),
          now: decision.update.updatedAt,
        })
        return decision.result
      })
    },
    isOwnerNameConstraintError(error) {
      return isPostgresqlUniqueViolation(error, POSTGRESQL_OWNER_NAME_UNIQUE_CONSTRAINTS)
    },
  }
  return Object.freeze(port)
}
