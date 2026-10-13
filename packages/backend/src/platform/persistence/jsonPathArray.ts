import { sql, type SQLWrapper } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { engineOf, type DatabaseTransaction } from './databaseTransaction'
import { unhandledDatabaseProvider } from './databaseProviders'

/** A nested JSON array remains JSON text on both engines. String-only identity
 * lookups use jsonPathText; scopes/visibility need the original entire array. */
export function jsonPathArray(
  db: ProviderNeutralDatabase | DatabaseTransaction,
  document: SQLWrapper,
  path: readonly string[],
) {
  if (!path.length || path.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new RangeError('Invalid original JSON array path')
  const provider = engineOf(db).provider
  if (provider === 'sqlite') {
    const literal = sql.raw("'$." + path.join('.') + "'")
    return sql<
      string | null
    >`CASE WHEN json_valid(${document}) THEN CASE WHEN json_type(${document}, ${literal}) = 'array' THEN json_extract(${document}, ${literal}) ELSE NULL END ELSE NULL END`
  }
  if (provider === 'postgresql') {
    const literal = sql.raw("'{" + path.join(',') + "}'")
    return sql<
      string | null
    >`CASE WHEN pg_input_is_valid(${document}, 'jsonb') THEN CASE WHEN jsonb_typeof((${document})::jsonb #> ${literal}) = 'array' THEN (${document})::jsonb #>> ${literal} ELSE NULL END ELSE NULL END`
  }
  return unhandledDatabaseProvider(provider)
}
