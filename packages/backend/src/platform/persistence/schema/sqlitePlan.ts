// RFC-395 I-a: a declaration projection for equivalence proofs, not a new boot baseline.
import type { SchemaRegistry } from './registry'
import { validateSchemaRegistry } from './registry'
import { CODECS } from './codecs'
import { digestSchemaContract } from './canonical'
import { quoteSchemaIdentifier as quote, renderSchemaExpression as render } from './expressions'

export function compileSqlitePlan(registry: SchemaRegistry) {
  validateSchemaRegistry(registry)
  const statements: { kind: 'table' | 'index'; logicalId: string; sql: string }[] = []
  for (const table of registry.tables) {
    const columns = Object.values(table.columns)
    const parts = columns.map((column) => {
      const pieces = [quote(column.name), CODECS[column.codec].sqlite.toUpperCase()]
      if (column.primary) pieces.push('PRIMARY KEY')
      if (column.codec === 'identity') pieces.push('AUTOINCREMENT')
      if (!column.nullable) pieces.push('NOT NULL')
      if (column.default.kind === 'literal')
        pieces.push(`DEFAULT ${render({ kind: 'literal', value: column.default.value }, 'sqlite')}`)
      if (column.default.kind === 'expression')
        pieces.push(`DEFAULT (${render(column.default.expression, 'sqlite')})`)
      if (column.unique) pieces.push(`CONSTRAINT ${quote(column.unique)} UNIQUE`)
      return pieces.join(' ')
    })
    if (!columns.some((column) => column.primary))
      parts.push(`PRIMARY KEY (${table.primaryKey.map(quote).join(', ')})`)
    for (const unique of table.unique)
      parts.push(
        `CONSTRAINT ${quote(unique.name)} UNIQUE (${unique.columns.map(quote).join(', ')})`,
      )
    for (const check of table.checks)
      parts.push(`CONSTRAINT ${quote(check.name)} CHECK (${render(check.expression, 'sqlite')})`)
    for (const fk of table.foreignKeys)
      parts.push(
        `CONSTRAINT ${quote(fk.name)} FOREIGN KEY (${fk.columns.map(quote).join(', ')}) REFERENCES ${quote(fk.foreignTable)} (${fk.foreignColumns.map(quote).join(', ')}) ON UPDATE ${fk.onUpdate.toUpperCase()} ON DELETE ${fk.onDelete.toUpperCase()}`,
      )
    statements.push({
      kind: 'table',
      logicalId: table.id,
      sql: `CREATE TABLE ${quote(table.id)} (\n  ${parts.join(',\n  ')}\n)`,
    })
  }
  for (const table of registry.tables)
    for (const index of table.indexes) {
      // SQLite index expressions may not qualify a local column by table name.
      const local = (value: Parameters<typeof render>[0]): string =>
        render(value, 'sqlite').replaceAll(`${quote(table.id)}.`, '')
      statements.push({
        kind: 'index',
        logicalId: `${table.id}:index:${index.name}`,
        sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${quote(table.id)} (${index.columns.map(local).join(', ')})${index.where ? ` WHERE ${local(index.where)}` : ''}`,
      })
    }
  const payload = { version: 1 as const, statements }
  return { ...payload, digest: digestSchemaContract(payload) }
}
