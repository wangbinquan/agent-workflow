import { and, eq, isNull, ne, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/** SQLite expression matching the NULL-normalized owner/name unique indexes. */
export function sqliteOwnerScopedNameWhere(
  ownerColumn: AnySQLiteColumn,
  nameColumn: AnySQLiteColumn,
  ownerUserId: string | null,
  name: string,
  excludeId?: { readonly column: AnySQLiteColumn; readonly id: string },
): SQL {
  const owner = ownerUserId === null ? isNull(ownerColumn) : eq(ownerColumn, ownerUserId)
  const identity = and(owner, eq(nameColumn, name))
  return excludeId === undefined ? identity! : and(identity, ne(excludeId.column, excludeId.id))!
}
