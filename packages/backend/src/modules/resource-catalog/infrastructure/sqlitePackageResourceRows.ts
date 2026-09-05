// RFC-359 W4-D20 —— 只剩「legacy SQLite 资源包提交路径」用得到的同步助手。
// 预览 / 导出读模型与 owner/name 查找已合成中立的 `packageResourceRows.ts`（两个 provider 共用）；
// 这里的四个 `*InTx` / 同步读随 `platform/persistence/sqlite/legacyResourcePackageCommit.ts` 一起退役。

import type { BundleResourceType } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { SQLITE_ACL_TABLES } from './sqliteAclRegistry'

export type SqlitePackageResourceRow = Record<string, unknown>

export async function getSqlitePackageResourceRow(
  db: DbClient,
  type: BundleResourceType,
  id: string,
): Promise<SqlitePackageResourceRow | undefined> {
  const table = SQLITE_ACL_TABLES[type]
  return (await db.select().from(table).where(eq(table.id, id)).get()) as
    | SqlitePackageResourceRow
    | undefined
}

export function getSqlitePackageResourceRowInTx(
  tx: DbTxSync,
  type: BundleResourceType,
  id: string,
): SqlitePackageResourceRow | undefined {
  const table = SQLITE_ACL_TABLES[type]
  return tx.select().from(table).where(eq(table.id, id)).get() as
    | SqlitePackageResourceRow
    | undefined
}

type SeededBuiltinResourceType = 'agent' | 'workflow'

function builtinColumnOf(type: SeededBuiltinResourceType): AnySQLiteColumn {
  return SQLITE_ACL_TABLES[type].builtin
}

export async function findSqliteBuiltinResource(
  db: DbClient,
  type: SeededBuiltinResourceType,
  name: string,
): Promise<{ readonly id: string; readonly name: string } | undefined> {
  const table = SQLITE_ACL_TABLES[type]
  return (await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.name, name), eq(builtinColumnOf(type), true)))
    .get()) as { id: string; name: string } | undefined
}

export function findSqliteBuiltinResourceInTx(
  tx: DbTxSync,
  type: SeededBuiltinResourceType,
  name: string,
): { readonly id: string; readonly name: string } | undefined {
  const table = SQLITE_ACL_TABLES[type]
  return tx
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.name, name), eq(builtinColumnOf(type), true)))
    .get() as { id: string; name: string } | undefined
}
