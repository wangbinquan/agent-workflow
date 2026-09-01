import type { ResourceAccess, ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import { agents, resourceGrants } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  hasResourceAclBypass,
  isVisibleRow,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
  type AclRow,
  type ResourceAclActorProjection,
} from '../domain/resourceAccess'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

async function grantedAgentIds(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: ResourceAclActorProjection,
): Promise<ReadonlySet<string>> {
  const rows = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, 'agent'), eq(resourceGrants.userId, actor.user.id)))
    .all()
  return new Set(rows.map((row) => row.resourceId))
}

async function agentAccessRows(
  transaction: PostgresqlResourceCatalogTransaction,
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
    .all()
  return new Map(rows.map((row) => [row.id, row]))
}

/** Async D15 preflight; unresolved ids remain owned by the existence validator. */
export async function resolvePostgresqlAgentIdsUsable(
  db: PostgresqlDatabaseClient,
  actor: ResourceAclActorProjection,
  ids: readonly string[],
  grandfatheredIds: ReadonlySet<string>,
): Promise<readonly string[]> {
  const refs = [...new Set(ids)].filter((id) => id.length > 0)
  if (refs.length === 0 || hasResourceAclBypass(actor)) return []
  return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
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

/** Final same-transaction D15 fence; a matched-then-deleted id fails closed. */
export async function assertPostgresqlAgentIdsUsableInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
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

export async function resolvePostgresqlAccessInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: ResourceAclActorProjection,
  type: 'workgroup',
  row: AclRow,
): Promise<ResourceAccess> {
  const audience = resourceAclAudienceAuthority(actor)
  let grant: ResourceGrantLevel | null = null
  if (!audience.bypass && audience.private) {
    const result = await transaction
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
      .get()
    grant = result?.level ?? null
  }
  return resolveAccessFrom(audience, actor.user.id, row, grant)
}

export async function listPostgresqlGrantedUserIdsInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
  type: 'workgroup',
  resourceId: string,
): Promise<readonly string[]> {
  const rows = await transaction
    .select({ userId: resourceGrants.userId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.resourceId, resourceId)))
    .all()
  return rows.map((row) => row.userId)
}
