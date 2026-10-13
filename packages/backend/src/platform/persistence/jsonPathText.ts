import type { SQLWrapper } from 'drizzle-orm'
import { engineOf, type DatabaseTransaction } from './databaseTransaction'
import type { ProviderNeutralDatabase } from '@/db/query'

/** Provider-neutral nested string identity lookup. Object-valued members must
 * not be passed through jsonMemberText, which deliberately accepts strings only. */
export function jsonPathText(
  db: ProviderNeutralDatabase | DatabaseTransaction,
  document: SQLWrapper,
  path: readonly string[],
) {
  if (!path.length || path.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new RangeError('Invalid original JSON identity path')
  return engineOf(db).jsonPathText(document, path)
}
