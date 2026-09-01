import type { ImportRefType } from '@agent-workflow/shared'
import { and, eq, inArray, or } from 'drizzle-orm'
import { resourceGrants, users } from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  AgentImportReferenceReadPort,
  TransactionBoundImportReferenceReadPort,
} from '../application/agents/importPorts'
import { hasPrivateResourceAccess, hasResourceAclBypass } from '../domain/resourceAccess'
import {
  projectAgentImportResolutionSnapshot,
  type AgentImportIdentityRow,
} from './agentImportSnapshot'
import { POSTGRESQL_ACL_TABLES } from './postgresqlAclRegistry'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

async function readSnapshot(
  transaction: PostgresqlResourceCatalogTransaction,
  authority: DirectAuthenticatedAuthority,
  selectors: Parameters<TransactionBoundImportReferenceReadPort['snapshot']>[1],
  selections: Parameters<TransactionBoundImportReferenceReadPort['snapshot']>[2],
) {
  const rows: AgentImportIdentityRow[] = []
  const grantedIdsByType = new Map<ImportRefType, ReadonlySet<string>>()
  const types = [
    ...new Set([
      ...selectors.map((entry) => entry.type),
      ...selections.map((entry) => entry.selector.type),
    ]),
  ]
  for (const type of types) {
    const table = POSTGRESQL_ACL_TABLES[type]
    const names = [
      ...new Set(selectors.filter((entry) => entry.type === type).map((entry) => entry.name)),
    ]
    const ids = [
      ...new Set(
        selections.filter((entry) => entry.selector.type === type).map((entry) => entry.resourceId),
      ),
    ]
    if (names.length > 0 || ids.length > 0) {
      const providerRows = await transaction
        .select({
          id: table.id,
          name: table.name,
          ownerUserId: table.ownerUserId,
          visibility: table.visibility,
          aclRevision: table.aclRevision,
        })
        .from(table)
        .where(
          or(
            names.length === 0 ? undefined : inArray(table.name, names),
            ids.length === 0 ? undefined : inArray(table.id, ids),
          ),
        )
        .all()
      rows.push(...providerRows.map((row) => ({ type, ...row })))
    }
    const granted =
      hasResourceAclBypass(authority) || !hasPrivateResourceAccess(authority)
        ? []
        : await transaction
            .select({ resourceId: resourceGrants.resourceId })
            .from(resourceGrants)
            .where(
              and(
                eq(resourceGrants.userId, authority.user.id),
                eq(resourceGrants.resourceType, type),
              ),
            )
            .all()
    grantedIdsByType.set(type, new Set(granted.map((entry) => entry.resourceId)))
  }

  const ownerIds = [
    ...new Set(rows.flatMap((row) => (row.ownerUserId === null ? [] : [row.ownerUserId]))),
  ]
  const userRows =
    ownerIds.length === 0
      ? []
      : await transaction
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(inArray(users.id, ownerIds))
          .all()
  return projectAgentImportResolutionSnapshot({
    authority,
    selectors,
    selections,
    rows,
    grantedIdsByType,
    usernamesById: new Map(userRows.map((row) => [row.id, row.username])),
  })
}

export function createPostgresqlImportReferenceReadPortInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
): TransactionBoundImportReferenceReadPort {
  return Object.freeze<TransactionBoundImportReferenceReadPort>({
    snapshot: (authority, selectors, selections) =>
      readSnapshot(transaction, authority, selectors, selections),
  })
}

export function createPostgresqlAgentImportReferenceReadPort(
  db: PostgresqlDatabaseClient,
): AgentImportReferenceReadPort {
  return Object.freeze<AgentImportReferenceReadPort>({
    snapshot: (authority, selectors, selections) =>
      runPostgresqlResourceCatalogTransaction(db, (transaction) =>
        readSnapshot(transaction, authority, selectors, selections),
      ),
  })
}
