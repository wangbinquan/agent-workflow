import type { ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import { agents, resourceGrants, workflows } from '@/db/schema'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { resolveAccessFrom, resourceAclAudienceAuthority } from '../../domain/resourceAccess'
import type { ResourceMemoryScopeRef, ResourceScopeAccess } from '../../public/types'

export type PostgresqlResourceScopeTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

export interface PostgresqlResourceScopeAccessParticipant {
  accessOf(
    transaction: PostgresqlResourceScopeTransaction,
    pair: Readonly<{ readonly authority: RequestAuthority; readonly actor: Actor }>,
    scope: ResourceMemoryScopeRef,
  ): Promise<ResourceScopeAccess>
}

async function loadScopeRow(
  transaction: PostgresqlResourceScopeTransaction,
  scope: ResourceMemoryScopeRef,
): Promise<Readonly<{ ownerUserId: string | null; visibility: 'private' | 'public' }> | null> {
  if (scope.kind === 'agent') {
    const rows = await transaction
      .select({ ownerUserId: agents.ownerUserId, visibility: agents.visibility })
      .from(agents)
      .where(eq(agents.id, scope.id))
      .limit(1)
      .all()
    return rows[0] ?? null
  }
  const rows = await transaction
    .select({ ownerUserId: workflows.ownerUserId, visibility: workflows.visibility })
    .from(workflows)
    .where(eq(workflows.id, scope.id))
    .limit(1)
    .all()
  return rows[0] ?? null
}

async function loadGrantLevel(
  transaction: PostgresqlResourceScopeTransaction,
  actor: Actor,
  scope: ResourceMemoryScopeRef,
): Promise<ResourceGrantLevel | null> {
  const authority = resourceAclAudienceAuthority(actor)
  if (authority.bypass || !authority.private) return null
  const rows = await transaction
    .select({ level: resourceGrants.level })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, scope.kind),
        eq(resourceGrants.resourceId, scope.id),
        eq(resourceGrants.userId, actor.user.id),
      ),
    )
    .limit(1)
    .all()
  return rows[0]?.level ?? null
}

/**
 * PostgreSQL implementation of Memory's exact resource-scope access port.
 *
 * Memory owns the surrounding atomic transaction and refreshes the admitted
 * actor inside it. Resource Catalog contributes only the agent/workflow ACL
 * decision and performs both the resource and grant reads on that same
 * transaction. No provider client, transaction handle, or row escapes through
 * resource-catalog public contracts.
 */
export function createPostgresqlResourceScopeAccessParticipant(): PostgresqlResourceScopeAccessParticipant {
  const participant: PostgresqlResourceScopeAccessParticipant = {
    async accessOf(transaction, pair, scope) {
      const row = await loadScopeRow(transaction, scope)
      if (row === null) return 'none'
      const grant = await loadGrantLevel(transaction, pair.actor, scope)
      return resolveAccessFrom(
        resourceAclAudienceAuthority(pair.actor),
        pair.actor.user.id,
        row,
        grant,
      )
    },
  }
  return Object.freeze(participant)
}
