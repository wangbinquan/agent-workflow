import type { ResourceGrantLevel } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import { resourceGrants } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  IntentContextResourceAuthorizationReadPort,
  IntentContextResourceAuthorizationRow,
} from '../application/ports/intentContextResourceAuthorization'
import type { CatalogSelectorKind } from '../domain/resourceKinds'
import { ACL_TABLES } from './aclRegistry'

/**
 * RFC-359 W4-D20 —— Intent 上下文的资源身份 / 授权读取：一份异步实现，两个 provider 共用
 * （此前 `sqliteIntentContextResourceAuthorization.ts` 与 `postgresqlIntentContextResourceAuthorization.ts`
 * 各一份）。RFC-359 W8：SQLite 的 `dbTxSync` 同步变体已随两个 SQLite bootstrap 改指异步工厂而删除，
 * 这里是整条链**唯一**的读实现。
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
