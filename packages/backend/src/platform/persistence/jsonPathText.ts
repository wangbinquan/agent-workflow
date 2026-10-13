import { sql, type SQLWrapper } from 'drizzle-orm'
import { engineOf, type DatabaseTransaction } from './databaseTransaction'
import type { ProviderNeutralDatabase } from '@/db/query'
import { unhandledDatabaseProvider } from './databaseProviders'

/** Provider-neutral nested string identity lookup. Object-valued members must
 * not be passed through jsonMemberText, which deliberately accepts strings only. */
export function jsonPathText(
  db: ProviderNeutralDatabase | DatabaseTransaction,
  document: SQLWrapper,
  path: readonly string[],
) {
  if (!path.length || path.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new RangeError('Invalid original JSON identity path')
  const provider = engineOf(db).provider
  if (provider === 'sqlite') {
    const literal = sql.raw("'$." + path.join('.') + "'")
    return sql`CASE WHEN json_valid(${document}) THEN CASE WHEN json_type(${document}, ${literal}) = 'text' THEN json_extract(${document}, ${literal}) ELSE NULL END ELSE NULL END`
  }
  if (provider === 'postgresql') {
    const literal = sql.raw("'{" + path.join(',') + "}'")
    return sql`CASE WHEN pg_input_is_valid(${document}, 'jsonb') THEN CASE WHEN jsonb_typeof((${document})::jsonb #> ${literal}) = 'string' THEN (${document})::jsonb #>> ${literal} ELSE NULL END ELSE NULL END`
  }
  return unhandledDatabaseProvider(provider)
}
