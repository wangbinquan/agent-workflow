import type { BundleResourceType } from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { SQLITE_ACL_TABLES } from './sqliteAclRegistry'

/**
 * Transitional T6 adapter for package characterization paths that still need
 * aggregate rows. It keeps dynamic SQLite table selection inside
 * infrastructure; the seven typed package participants replace these raw-row
 * reads when their aggregate cohorts cut over.
 */
export type SqlitePackageResourceRow = Record<string, unknown>

export async function listSqlitePackageResourceRowsByIds(
  db: DbClient,
  type: BundleResourceType,
  ids: readonly string[],
  options: { readonly orderById?: boolean } = {},
): Promise<SqlitePackageResourceRow[]> {
  if (ids.length === 0) return []
  const table = SQLITE_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.id, [...ids]))
  const rows = options.orderById === true ? await query.orderBy(asc(table.id)) : await query
  return rows as unknown as SqlitePackageResourceRow[]
}

export async function listSqlitePackageResourceRowsByNames(
  db: DbClient,
  type: BundleResourceType,
  names: readonly string[],
  options: { readonly orderById?: boolean } = {},
): Promise<SqlitePackageResourceRow[]> {
  if (names.length === 0) return []
  const table = SQLITE_ACL_TABLES[type]
  const query = db
    .select()
    .from(table)
    .where(inArray(table.name, [...names]))
  const rows = options.orderById === true ? await query.orderBy(asc(table.id)) : await query
  return rows as unknown as SqlitePackageResourceRow[]
}

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
