// RFC-395 I-a: the registry is a value assembled by bootstrap, never a global registration side effect.
import { CODECS } from './codecs'
import type { SchemaContribution, TableDefinition } from './contribution'
import { renderSchemaExpression } from './expressions'

export interface SchemaRegistry<
  T extends readonly SchemaContribution[] = readonly SchemaContribution[],
> {
  readonly contributions: T
  readonly tables: readonly T[number]['tables'][number][]
}
export function createSchemaRegistry<const T extends readonly SchemaContribution[]>(
  contributions: T,
): SchemaRegistry<T> {
  const registry = {
    contributions,
    tables: contributions.flatMap((entry) => entry.tables) as T[number]['tables'][number][],
  }
  validateSchemaRegistry(registry)
  return Object.freeze(registry)
}
export function validateSchemaRegistry(registry: SchemaRegistry): void {
  const byId = new Map<string, TableDefinition>()
  const symbols = new Set<string>()
  for (const contribution of registry.contributions) {
    if (!contribution.owner?.trim()) throw new Error('RFC-395 missing contribution owner')
    for (const table of contribution.tables) {
      if (!table.owner?.trim() || table.owner !== contribution.owner)
        throw new Error(`RFC-395 missing or mismatched owner: ${table.id}`)
      if (byId.has(table.id) || symbols.has(table.schemaSymbol))
        throw new Error(`RFC-395 duplicate table: ${table.id}`)
      byId.set(table.id, table)
      symbols.add(table.schemaSymbol)
      const names = Object.values(table.columns).map((column) => column.name)
      if (new Set(names).size !== names.length)
        throw new Error(`RFC-395 duplicate column: ${table.id}`)
      for (const column of Object.values(table.columns)) {
        if (!column.codec || !Object.hasOwn(CODECS, column.codec))
          throw new Error(`RFC-395 missing codec: ${table.id}.${column.name}`)
        if (column.codec === 'jsonDoc' && column.originalTextDigest)
          throw new Error(
            `RFC-395 jsonDoc violates original-text digest: ${table.id}.${column.name}`,
          )
        if ((column.codec === 'identity' || column.codec === 'seq') && !column.highWater)
          throw new Error(
            `RFC-395 identity/seq missing high-water policy: ${table.id}.${column.name}`,
          )
        if (column.codec === 'enum' && !column.enumValues?.length)
          throw new Error(`RFC-395 empty enum: ${table.id}.${column.name}`)
        if (column.default.kind === 'expression') {
          renderSchemaExpression(column.default.expression, 'sqlite')
          renderSchemaExpression(column.default.expression, 'postgresql')
        }
      }
      for (const key of [table.primaryKey, table.migrationKey]) {
        if (!key.length || key.some((name) => !names.includes(name)))
          throw new Error(`RFC-395 invalid migration/primary key: ${table.id}`)
      }
      for (const check of table.checks) {
        renderSchemaExpression(check.expression, 'sqlite')
        renderSchemaExpression(check.expression, 'postgresql')
      }
      for (const index of table.indexes)
        for (const expression of [...index.columns, ...(index.where ? [index.where] : [])]) {
          renderSchemaExpression(expression, 'sqlite')
          renderSchemaExpression(expression, 'postgresql')
        }
    }
  }
  if (
    registry.tables.length !== byId.size ||
    registry.tables.some((table) => byId.get(table.id) !== table)
  )
    throw new Error('RFC-395 registry table roster differs from contributions')
  for (const table of registry.tables)
    for (const foreignKey of table.foreignKeys) {
      const target = byId.get(foreignKey.foreignTable)
      if (!target)
        throw new Error(
          `RFC-395 missing logical FK target: ${table.id} -> ${foreignKey.foreignTable}`,
        )
      const ownNames = Object.values(table.columns).map((column) => column.name)
      const targetNames = Object.values(target.columns).map((column) => column.name)
      if (
        !foreignKey.lifecycle.trim() ||
        !foreignKey.columns.length ||
        foreignKey.columns.length !== foreignKey.foreignColumns.length ||
        foreignKey.columns.some((name) => !ownNames.includes(name)) ||
        foreignKey.foreignColumns.some((name) => !targetNames.includes(name))
      )
        throw new Error(`RFC-395 invalid FK: ${foreignKey.name}`)
    }
}
