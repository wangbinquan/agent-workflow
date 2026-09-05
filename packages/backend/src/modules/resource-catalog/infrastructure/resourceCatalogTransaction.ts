// RFC-359 W4-B2 —— resource-catalog 的写事务：一份原语，两个 provider 共用。
//
// 此前 SQLite 走 dbTxSync、PG 走 `postgresql/repositorySupport.ts` 的 SERIALIZABLE + 序列化冲突重试。
// 目录写入有跨行不变量（owner + name 唯一、grant 与 ACL 行成对、包应用的多表成组），沿用 SERIALIZABLE
// （`DatabaseSession.serializable`：PG 抬升隔离级别并按 40001/40P01 退避重试；SQLite 与 transaction 同一条路）。

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'

export type ResourceCatalogTransaction = DatabaseTransaction

export function runResourceCatalogTransaction<T>(
  db: ProviderNeutralDatabase,
  body: (transaction: ResourceCatalogTransaction) => Promise<T>,
): Promise<T> {
  return databaseSessionFor(db).serializable(body)
}
