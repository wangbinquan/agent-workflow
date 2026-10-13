import type { SQLWrapper } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { engineOf, type DatabaseTransaction } from './databaseTransaction'

/** A nested JSON array remains JSON text on both engines. String-only identity
 * lookups use jsonPathText; scopes/visibility need the original entire array. */
export function jsonPathArray(
  db: ProviderNeutralDatabase | DatabaseTransaction,
  document: SQLWrapper,
  path: readonly string[],
) {
  if (!path.length || path.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new RangeError('Invalid original JSON array path')
  return engineOf(db).jsonPathArray(document, path)
}
