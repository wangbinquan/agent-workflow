import type { ImportRefSelection, ImportRefSelector, ImportRefType } from '@agent-workflow/shared'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { resourceGrants, users } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  AgentImportReferenceReadPort,
  TransactionBoundImportReferenceSyncReadPort,
} from '../application/agents/importPorts'
import { hasPrivateResourceAccess, hasResourceAclBypass } from '../domain/resourceAccess'
import { SQLITE_ACL_TABLES } from './sqliteAclRegistry'
import {
  projectAgentImportResolutionSnapshot,
  type AgentImportIdentityRow,
} from './agentImportSnapshot'

function readSnapshot(
  transaction: DbTxSync,
  authority: DirectAuthenticatedAuthority,
  selectors: readonly ImportRefSelector[],
  selections: readonly ImportRefSelection[],
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
    const table = SQLITE_ACL_TABLES[type]
    const names = [
      ...new Set(selectors.filter((entry) => entry.type === type).map((entry) => entry.name)),
    ]
    const ids = [
      ...new Set(
        selections.filter((entry) => entry.selector.type === type).map((entry) => entry.resourceId),
      ),
    ]
    if (names.length > 0 || ids.length > 0) {
      rows.push(
        ...transaction
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
          .map((row) => ({ type, ...row })),
      )
    }
    const granted =
      hasResourceAclBypass(authority) || !hasPrivateResourceAccess(authority)
        ? []
        : transaction
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
      : transaction
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

export function createSqliteImportReferenceSyncReadPort(
  transaction: DbTxSync,
): TransactionBoundImportReferenceSyncReadPort {
  return Object.freeze<TransactionBoundImportReferenceSyncReadPort>({
    snapshotSync(authority, selectors, selections) {
      return readSnapshot(transaction, authority, selectors, selections)
    },
  })
}

export function createSqliteAgentImportReferenceReadPort(
  db: DbClient,
): AgentImportReferenceReadPort {
  return Object.freeze<AgentImportReferenceReadPort>({
    async snapshot(authority, selectors, selections) {
      return dbTxSync(db, (transaction) =>
        createSqliteImportReferenceSyncReadPort(transaction).snapshotSync(
          authority,
          selectors,
          selections,
        ),
      )
    },
  })
}
