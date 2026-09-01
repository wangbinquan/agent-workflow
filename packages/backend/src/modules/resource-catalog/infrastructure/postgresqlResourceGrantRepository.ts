import type { AclResourceType, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { resourceGrants } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceCatalogGrantReadPort } from '../application/ports/providerResourceCatalogPersistence'
import {
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'

function grantsOfUserWhere(type: AclResourceType, userId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, userId))
}

function grantsOfResourceWhere(type: AclResourceType, resourceId: string) {
  return and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId))
}

export interface PostgresqlAclColumnRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
  readonly visibility: SQLWrapper
}

export function postgresqlVisibleRowsCondition(
  db: PostgresqlDatabaseClient,
  actor: ResourceAclActorProjection,
  type: AclResourceType,
  columns: PostgresqlAclColumnRef,
): SQL<unknown> | undefined {
  if (hasResourceAclBypass(actor)) return undefined
  const isPublic = sql`COALESCE(${columns.visibility}, 'public') = 'public'`
  if (!hasPrivateResourceAccess(actor)) return isPublic
  const granted = inArray(
    columns.id,
    db
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(grantsOfUserWhere(type, actor.user.id)),
  )
  return or(isPublic, sql`${columns.ownerUserId} = ${actor.user.id}`, granted)!
}

export function createPostgresqlResourceGrantReadPort(
  db: PostgresqlDatabaseClient,
): ResourceCatalogGrantReadPort {
  const port: ResourceCatalogGrantReadPort = {
    async listGrantedResourceIds(actor, type) {
      const rows = await db
        .select({ resourceId: resourceGrants.resourceId })
        .from(resourceGrants)
        .where(grantsOfUserWhere(type, actor.user.id))
        .all()
      return new Set(rows.map((row) => row.resourceId))
    },
    async loadGrantLevel(type, resourceId, userId) {
      const row = await db
        .select({ level: resourceGrants.level })
        .from(resourceGrants)
        .where(and(grantsOfResourceWhere(type, resourceId), eq(resourceGrants.userId, userId)))
        .limit(1)
        .get()
      return row?.level ?? null
    },
    async loadGrantLevelsForUser(type, resourceIds, userId) {
      const out = new Map<string, ResourceGrantLevel>()
      for (let index = 0; index < resourceIds.length; index += 500) {
        const chunk = resourceIds.slice(index, index + 500)
        const rows = await db
          .select({ resourceId: resourceGrants.resourceId, level: resourceGrants.level })
          .from(resourceGrants)
          .where(and(grantsOfUserWhere(type, userId), inArray(resourceGrants.resourceId, chunk)))
          .all()
        for (const row of rows) out.set(row.resourceId, row.level)
      }
      return out
    },
  }
  return Object.freeze(port)
}
