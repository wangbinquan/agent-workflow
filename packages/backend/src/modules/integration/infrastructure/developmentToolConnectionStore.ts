import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentAdapterDefinitionRevisions,
  developmentAdapterDefinitions,
  resourceGrants,
} from '@/db/schema'
import type { DevelopmentAdapterIdentityRow } from '../application/developmentAdapterCommands'
import { toIdentityRow } from './developmentAdapterStore'

interface DevelopmentToolConnectionStore {
  identity(id: string): Promise<DevelopmentAdapterIdentityRow | null>
  identities(): Promise<readonly DevelopmentAdapterIdentityRow[]>
  revision(
    id: string,
    revision: number,
  ): Promise<{ readonly contentJson: string; readonly contentDigest: string } | null>
  grantedUserIds(id: string): Promise<ReadonlySet<string>>
}

/**
 * RFC-359 AC-1（plan §5ft）—— **两个 provider 唯一的一份**工具连接读取。
 *
 * 此前这里是一对孪生，两份函数体逐行对应，差别只有两处：
 *   · SQLite 那份用 bun:sqlite 的**同步** `.get()` / `.all()`，PG 那份 `await`；
 *   · PG 那份多一个 `.limit(1)`。
 *
 * 两处都不命中 §5fq 的三条「差异源于引擎本身」——不是独有原语、不是独有资源形态、
 * 也不是驱动强加的线上差异，只是**当初一份是照着同步 API 写的**。
 *
 * 同步那份写法的代价是真的：在 PostgreSQL 客户端上 `.get()` 返回 Promise，
 * `row === undefined` 于是**恒为 false**，投影会拿到一个 Promise 而不是行——错得无声无息。
 * 合一取「`await` + `.limit(1)` + 取第 0 行」这一半：它在两个引擎上都成立，
 * 而同步那半只在一个引擎上成立。
 */
export function createDevelopmentToolConnectionStore(
  db: ProviderNeutralDatabase,
): DevelopmentToolConnectionStore {
  return {
    async identity(id) {
      const rows = await db
        .select()
        .from(developmentAdapterDefinitions)
        .where(eq(developmentAdapterDefinitions.id, id))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toIdentityRow(row)
    },
    async identities() {
      return (await db.select().from(developmentAdapterDefinitions)).map(toIdentityRow)
    },
    async revision(id, revision) {
      const rows = await db
        .select({
          contentJson: developmentAdapterDefinitionRevisions.contentJson,
          contentDigest: developmentAdapterDefinitionRevisions.contentDigest,
        })
        .from(developmentAdapterDefinitionRevisions)
        .where(
          and(
            eq(developmentAdapterDefinitionRevisions.adapterId, id),
            eq(developmentAdapterDefinitionRevisions.revision, revision),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
    async grantedUserIds(id) {
      const rows = await db
        .select({ userId: resourceGrants.userId })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, 'development_adapter'),
            eq(resourceGrants.resourceId, id),
          ),
        )
      return new Set(rows.map((row) => row.userId))
    },
  }
}

export type { DevelopmentToolConnectionStore }
