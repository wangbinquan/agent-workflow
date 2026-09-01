import { sqliteOwnerScopedNameWhere } from '@/modules/identity-access/composition/providerOperations'
import { isOwnerScopedNameConflict } from '@/modules/identity-access/public/operations'

/**
 * RFC-223 — NULL-safe `(owner_user_id, name)` lookup matching the expression
 * unique indexes created by migration 0118 (`COALESCE(owner_user_id, ''), name`).
 */
export function ownerScopedNameWhere(
  ...args: Parameters<typeof sqliteOwnerScopedNameWhere>
): ReturnType<typeof sqliteOwnerScopedNameWhere> {
  return sqliteOwnerScopedNameWhere(...args)
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
