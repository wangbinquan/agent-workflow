import type { ResourceGrantLevel } from '@agent-workflow/shared'
import type { DbTxSync } from '@/db/txSync'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import type {
  IntentContextResourceAuthorizationRow,
  IntentContextResourceAuthorizationReadPort,
  IntentContextResourceAuthorizationSyncReadPort,
} from '../application/ports/intentContextResourceAuthorization'
import { getAclResourceIdentityRowInTx } from './sqliteAclReadRepository'
import { loadGrantLevelInTx } from './sqliteResourceGrantRepository'

/** Synchronous reads for callers already inside the owning SQLite transaction. */
export function createSqliteIntentContextResourceAuthorizationSyncReadPort(
  transaction: DbTxSync,
): IntentContextResourceAuthorizationSyncReadPort {
  return Object.freeze({
    loadIdentity(
      resourceType: CatalogSelectorKind,
      resourceId: string,
    ): IntentContextResourceAuthorizationRow | null {
      const row = getAclResourceIdentityRowInTx(transaction, resourceType, resourceId)
      return row === null
        ? null
        : Object.freeze({
            resourceType,
            resourceId: row.id,
            name: row.name,
            ownerUserId: row.ownerUserId ?? null,
            visibility: row.visibility ?? 'public',
          })
    },
    loadGrantLevel(
      resourceType: CatalogSelectorKind,
      resourceId: string,
      userId: string,
    ): ResourceGrantLevel | null {
      return loadGrantLevelInTx(transaction, resourceType, resourceId, userId)
    },
  })
}

/** Bind Intent context identity/grant reads to the caller's current SQLite tx. */
export function createSqliteIntentContextResourceAuthorizationReadPort(
  transaction: DbTxSync,
): IntentContextResourceAuthorizationReadPort {
  const reads = createSqliteIntentContextResourceAuthorizationSyncReadPort(transaction)
  const port: IntentContextResourceAuthorizationReadPort = {
    async loadIdentity(
      resourceType: CatalogSelectorKind,
      resourceId: string,
    ): Promise<IntentContextResourceAuthorizationRow | null> {
      return reads.loadIdentity(resourceType, resourceId)
    },
    async loadGrantLevel(
      resourceType: CatalogSelectorKind,
      resourceId: string,
      userId: string,
    ): Promise<ResourceGrantLevel | null> {
      return reads.loadGrantLevel(resourceType, resourceId, userId)
    },
  }
  return Object.freeze(port)
}
