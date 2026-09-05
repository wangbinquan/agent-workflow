import type { ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import { resourceGrants } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  IntentContextResourceAuthorizationReadPort,
  IntentContextResourceAuthorizationRow,
  IntentContextResourceAuthorizationSyncReadPort,
} from '../application/ports/intentContextResourceAuthorization'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { ACL_TABLES } from './aclRegistry'
import { getAclResourceIdentityRowInTx } from './sqliteAclReadRepository'
import { loadGrantLevelInTx } from './sqliteResourceGrantRepository'

/**
 * RFC-359 W4-D20 —— Intent 上下文的资源身份 / 授权读取：一份异步实现，两个 provider 共用
 * （此前 `sqliteIntentContextResourceAuthorization.ts` 与 `postgresqlIntentContextResourceAuthorization.ts`
 * 各一份，且 SQLite 的那份异步工厂零生产消费——两个 SQLite bootstrap 用的都是下面的同步变体）。
 */
export function createIntentContextResourceAuthorizationReadPort(
  transaction: DatabaseTransaction,
): IntentContextResourceAuthorizationReadPort {
  const port: IntentContextResourceAuthorizationReadPort = {
    async loadIdentity(
      resourceType: CatalogSelectorKind,
      resourceId: string,
    ): Promise<IntentContextResourceAuthorizationRow | null> {
      const table = ACL_TABLES[resourceType]
      const row = (
        await transaction
          .select({
            id: table.id,
            name: table.name,
            ownerUserId: table.ownerUserId,
            visibility: table.visibility,
          })
          .from(table)
          .where(eq(table.id, resourceId))
          .limit(1)
      )[0]
      return row === undefined
        ? null
        : Object.freeze({
            resourceType,
            resourceId: row.id,
            name: row.name,
            ownerUserId: row.ownerUserId ?? null,
            visibility: row.visibility ?? 'public',
          })
    },
    async loadGrantLevel(
      resourceType: CatalogSelectorKind,
      resourceId: string,
      userId: string,
    ): Promise<ResourceGrantLevel | null> {
      const row = (
        await transaction
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
      )[0]
      return row?.level ?? null
    },
  }
  return Object.freeze(port)
}

/**
 * 同步变体：Intent 宿主在 SQLite 上仍跑在 `dbTxSync` 回调里，回调内不能 await，所以这一份必须留着。
 * 它与上面的异步实现读的是同一批行、同一套判据；随 Intent 宿主切到统一事务原语后退役（RFC-359 留债）。
 */
export function createIntentContextResourceAuthorizationSyncReadPort(
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
