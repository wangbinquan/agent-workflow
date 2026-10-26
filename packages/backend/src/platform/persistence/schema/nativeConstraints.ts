// RFC-395 II-b R1: additional target codec checks and NULL-equal unique keys.
import type { TableDefinition } from './contribution'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../databaseProviders'
import { CODECS } from './codecs'
import { quoteSchemaIdentifier as quote, renderSchemaExpression as render } from './expressions'

// Reused enum codecs become executable CHECKs in epoch 2; V1/V2 profile frozen source values (M6).
export function targetCodecChecks(
  table: TableDefinition,
  provider: DatabaseProvider,
): readonly { name: string; sql: string }[] {
  return Object.values(table.columns).flatMap((column) => {
    const name = `${table.id}_${column.name}_codec`
    const value = quote(column.name)
    if (column.document?.kind === 'content-ref') {
      const bytes = quote(column.document.inlineBytesColumn)
      let version: string
      switch (provider) {
        case 'sqlite':
          version = '1'
          break
        case 'postgresql':
          version = "'1'"
          break
        default:
          return unhandledDatabaseProvider(provider)
      }
      return [
        {
          name,
          sql: `(${value} IS NULL AND ${bytes} IS NULL) OR (json_valid(${value}) AND json_extract(${value}, '$.version') IS NOT NULL AND json_extract(${value}, '$.kind') IS NOT NULL AND json_extract(${value}, '$.version') = ${version} AND ((json_extract(${value}, '$.kind') = 'inline' AND ${bytes} IS NOT NULL) OR (json_extract(${value}, '$.kind') IN ('local-file', 'database-bytes', 'object') AND ${bytes} IS NULL)))`,
        },
      ]
    }
    if (column.document?.kind === 'requested-source') return [{ name, sql: `json_valid(${value})` }]
    if (column.codec === 'bool' && CODECS.bool[provider] === 'integer')
      return [{ name, sql: `${value} IN (0, 1)` }]
    if (column.codec === 'enum')
      return [
        {
          name,
          sql: `${value} IN (${column.enumValues!.map((value) => render({ kind: 'literal', value }, provider)).join(', ')})`,
        },
      ]
    if (column.codec === 'jsonDoc')
      return [{ name, sql: CODECS.jsonDoc[provider] === 'text' ? `json_valid(${value})` : 'TRUE' }]
    return []
  })
}
/** The NULL discriminator prevents the COALESCE fallback from colliding with real values. */
// Expression indexes cannot be targeted by ON CONFLICT(column); callers must use the declared expression (M8).
export function sqliteNullsNotDistinct(expressions: readonly string[]): readonly string[] {
  return expressions.flatMap((expression) => [
    `(${expression} IS NULL)`,
    `COALESCE(${expression}, '')`,
  ])
}
