// RFC-395: SQLite head and typed history-edge DDL share this provider compiler.
import { compileContract } from './contract'
import { compileRowRules } from './rowRules'
import { targetCodecChecks, sqliteNullsNotDistinct } from './nativeConstraints'
import type { SchemaRegistry } from './registry'
import { validateSchemaRegistry } from './registry'
import { CODECS } from './codecs'
import { digestSchemaContract } from './canonical'
import { quoteSchemaIdentifier as quote, renderSchemaExpression as render } from './expressions'
import { resolveColumnUniqueNulls } from './targetDefinition'
import { rebindSqliteTableReferences } from './sqliteReferences'

export function compileSqlitePlan(registry: SchemaRegistry) {
  validateSchemaRegistry(registry)
  const tables = registry.tables.map((table) => resolveColumnUniqueNulls(registry, table))
  const statements: {
    kind: 'table' | 'index' | 'trigger' | 'function'
    logicalId: string
    sql: string
  }[] = []
  for (const table of tables) {
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
      if (column.unique && column.uniqueNulls !== 'not-distinct')
        pieces.push(`CONSTRAINT ${quote(column.unique)} UNIQUE`)
      return pieces.join(' ')
    })
    if (!columns.some((column) => column.primary))
      parts.push(`PRIMARY KEY (${table.primaryKey.map(quote).join(', ')})`)
    for (const unique of table.unique.filter((unique) => unique.nulls !== 'not-distinct'))
      parts.push(
        `CONSTRAINT ${quote(unique.name)} UNIQUE (${unique.columns.map(quote).join(', ')})`,
      )
    for (const check of table.checks)
      parts.push(
        `CONSTRAINT ${quote(check.name)} CHECK (${rebindSqliteTableReferences(render(check.expression, 'sqlite'), table.id, null)})`,
      )
    if ((registry.schemaEpoch ?? 1) > 1)
      for (const check of targetCodecChecks(table, 'sqlite'))
        parts.push(`CONSTRAINT ${quote(check.name)} CHECK (${check.sql})`)
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
  for (const table of tables) {
    const nullEqualKeys = [
      ...table.unique.filter((unique) => unique.nulls === 'not-distinct'),
      ...Object.values(table.columns)
        .filter((column) => column.unique && column.uniqueNulls === 'not-distinct')
        .map((column) => ({ name: column.unique!, columns: [column.name] })),
    ]
    for (const key of nullEqualKeys)
      statements.push({
        kind: 'index',
        logicalId: `${table.id}:unique:${key.name}`,
        sql: `CREATE UNIQUE INDEX ${quote(key.name)} ON ${quote(table.id)} (${sqliteNullsNotDistinct(key.columns.map(quote)).join(', ')})`,
      })
    for (const index of table.indexes) {
      // SQLite index expressions may not qualify a local column by table name.
      const local = (value: Parameters<typeof render>[0]): string =>
        rebindSqliteTableReferences(render(value, 'sqlite'), table.id, null)
      statements.push({
        kind: 'index',
        logicalId: `${table.id}:index:${index.name}`,
        sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${quote(table.id)} (${(index.unique && index.nulls === 'not-distinct' ? sqliteNullsNotDistinct(index.columns.map(local)) : index.columns.map(local)).join(', ')})${index.where ? ` WHERE ${local(index.where)}` : ''}`,
      })
    }
    statements.push(...compileRowRules(table, 'sqlite'))
  }
  const payload = {
    version: 1 as const,
    ...((registry.schemaEpoch ?? 1) > 1
      ? {
          schemaEpoch: registry.schemaEpoch,
          contract: compileContract(registry),
          contractDigest: compileContract(registry).digest,
        }
      : {}),
    statements,
  }
  return { ...payload, digest: digestSchemaContract(payload) }
}

import type { ColumnDefinition, TableDefinition } from './contribution'
import { SchemaHistoryError, type HistoryStatement, type SchemaEdge } from './history/types'

function orderedColumns(table: TableDefinition): readonly ColumnDefinition[] {
  const columns = Object.values(table.columns)
  return 'columnOrder' in table
    ? (table.columnOrder as readonly string[]).map(
        (name) => columns.find((column) => column.name === name)!,
      )
    : columns
}
function belongs(statement: HistoryStatement, tableId: string): boolean {
  return statement.logicalId === tableId || statement.logicalId.startsWith(`${tableId}:`)
}
export function compileSqliteHistoryRebuild(
  before: TableDefinition,
  after: TableDefinition,
  head: readonly HistoryStatement[],
  edge: SchemaEdge,
): string[] {
  const create = head.find((s) => s.kind === 'table' && s.logicalId === after.id)
  if (!create) throw new SchemaHistoryError('table-plan-missing', after.id)
  const temporary = `__aw_rebuild_${after.id}`
  const prefix = `CREATE TABLE ${quote(after.id)}`
  if (!create.sql.startsWith(prefix)) throw new SchemaHistoryError('table-plan-shape', after.id)
  const columns = orderedColumns(after)
  const oldNames = new Set(Object.values(before.columns).map((c) => c.name))
  const copy = edge.kind === 'rebuild-table' ? (edge.copy ?? {}) : {}
  if (Object.keys(copy).some((name) => !columns.some((c) => c.name === name)))
    throw new SchemaHistoryError('copy-column-missing', after.id)
  const copied = columns.filter((c) => copy[c.name] || oldNames.has(c.name))
  if (!copied.length) throw new SchemaHistoryError('copy-mapping-required', after.id)
  const identity =
    Object.values(before.columns).some((c) => c.codec === 'identity') &&
    columns.some((c) => c.codec === 'identity')
  const sequence = `${temporary}_sequence`
  // Official 12-step ordering: create new, copy, drop old, rename new, restore dependents.
  // FK OFF / BEGIN / foreign_key_check / COMMIT / FK ON belong to the executor.
  return [
    ...(identity
      ? [
          `CREATE TEMP TABLE ${quote(sequence)} AS SELECT seq FROM sqlite_sequence WHERE name = ${render({ kind: 'literal', value: before.id }, 'sqlite')}`,
        ]
      : []),
    rebindSqliteTableReferences(
      rebindSqliteTableReferences(create.sql, after.id, null),
      after.id,
      temporary,
    ),
    `INSERT INTO ${quote(temporary)} (${copied.map((c) => quote(c.name)).join(', ')}) SELECT ${copied.map((c) => (copy[c.name] ? render(copy[c.name]!, 'sqlite') : quote(c.name))).join(', ')} FROM ${quote(before.id)}`,
    `DROP TABLE ${quote(before.id)}`,
    `ALTER TABLE ${quote(temporary)} RENAME TO ${quote(after.id)}`,
    ...head.filter((s) => belongs(s, after.id) && s.kind !== 'table').map((s) => s.sql),
    ...(identity
      ? [
          `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(seq) FROM ${quote(sequence)}), seq)) WHERE name = ${render({ kind: 'literal', value: after.id }, 'sqlite')}`,
          `DROP TABLE ${quote(sequence)}`,
        ]
      : []),
  ]
}
