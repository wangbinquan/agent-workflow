import { and, eq, isNull, ne, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * RFC-223 — NULL-safe `(owner_user_id, name)` lookup matching the expression
 * unique indexes created by migration 0118 (`COALESCE(owner_user_id, ''), name`).
 */
export function ownerScopedNameWhere(
  ownerColumn: AnySQLiteColumn,
  nameColumn: AnySQLiteColumn,
  ownerUserId: string | null,
  name: string,
  excludeId?: { column: AnySQLiteColumn; id: string },
): SQL {
  const owner = ownerUserId === null ? isNull(ownerColumn) : eq(ownerColumn, ownerUserId)
  const identity = and(owner, eq(nameColumn, name))
  return excludeId === undefined ? identity! : and(identity, ne(excludeId.column, excludeId.id))!
}

/**
 * Map both the expression-index error used after migration 0118 and the legacy
 * single-column unique error used during rolling-upgrade tests.
 */
export function isOwnerNameUniqueViolation(
  error: unknown,
  table: string,
  indexName: string,
): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)) {
    return false
  }
  return message.includes(indexName) || message.includes(`${table}.name`)
}
