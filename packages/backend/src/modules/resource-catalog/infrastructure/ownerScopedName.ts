import { and, eq, isNull, ne, type SQL } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { isOwnerScopedNameConflict } from '../application/ownerScopedName'

/** Shared expression matching the NULL-normalized owner/name unique indexes. */
export function ownerScopedNameCondition(
  ownerColumn: AnyColumn,
  nameColumn: AnyColumn,
  ownerUserId: string | null,
  name: string,
  excludeId?: { readonly column: AnyColumn; readonly id: string },
): SQL {
  const owner = ownerUserId === null ? isNull(ownerColumn) : eq(ownerColumn, ownerUserId)
  const identity = and(owner, eq(nameColumn, name))
  return excludeId === undefined ? identity! : and(identity, ne(excludeId.column, excludeId.id))!
}

// RFC-459 (RFC-294 W9-D): moved here with the condition from `services/ownerScopedName.ts`; resource-catalog is the only
// production owner of the owner-scoped unique names (agents, skills, MCP servers, plugins).
/**
 * RFC-223 — NULL-safe `(owner_user_id, name)` lookup matching the expression
 * unique indexes created by migration 0118 (`COALESCE(owner_user_id, ''), name`).
 */
export function ownerScopedNameWhere(
  ...args: Parameters<typeof ownerScopedNameCondition>
): ReturnType<typeof ownerScopedNameCondition> {
  return ownerScopedNameCondition(...args)
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
  return isOwnerScopedNameConflict(error, { table, indexName })
}
