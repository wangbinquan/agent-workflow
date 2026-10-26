// RFC-395 I-a: the registry is a value assembled by bootstrap, never a global registration side effect.
import { CODECS } from './codecs'
import { hasImplicitIndexNulls } from './dsl'
import type { SchemaContribution, TableDefinition } from './contribution'
import { validateRowCondition } from './rowRules'
import { compileInstallSeeds } from './seeds'
import { renderSchemaExpression } from './expressions'
import { resolveColumnUniqueNulls } from './targetDefinition'

export interface SchemaRegistry<
  T extends readonly SchemaContribution[] = readonly SchemaContribution[],
> {
  /** Absent in the frozen epoch-1 serialization. */
  readonly schemaEpoch?: number
  readonly contributions: T
  readonly tables: readonly T[number]['tables'][number][]
}
export function createSchemaRegistry<const T extends readonly SchemaContribution[]>(
  contributions: T,
  options: { readonly schemaEpoch?: number } = {},
): SchemaRegistry<T> {
  const registry = {
    ...(options.schemaEpoch !== undefined && options.schemaEpoch !== 1
      ? { schemaEpoch: options.schemaEpoch }
      : {}),
    contributions,
    tables: contributions.flatMap((entry) => entry.tables) as T[number]['tables'][number][],
  }
  validateSchemaRegistry(registry)
  return Object.freeze(registry)
}
export function validateSchemaRegistry(registry: SchemaRegistry): void {
  if (
    registry.schemaEpoch !== undefined &&
    (!Number.isSafeInteger(registry.schemaEpoch) || registry.schemaEpoch < 1)
  )
    throw new Error('RFC-395 invalid schema epoch')
  const byId = new Map<string, TableDefinition>()
  const symbols = new Set<string>()
  for (const contribution of registry.contributions) {
    if (!contribution.owner?.trim()) throw new Error('RFC-395 missing contribution owner')
    const declaredNulls = new Set<string>()
    for (const rule of contribution.columnUniqueNulls ?? []) {
      const table = contribution.tables.find((table) => table.id === rule.table)
      const column =
        table && Object.values(table.columns).find((column) => column.name === rule.column)
      const key = JSON.stringify([rule.table, rule.column])
      if (
        !column?.unique ||
        !column.nullable ||
        column.uniqueNulls !== undefined ||
        !['distinct', 'not-distinct'].includes(rule.nulls) ||
        declaredNulls.has(key)
      )
        throw new Error('RFC-395 invalid or duplicate column unique NULL semantics')
      declaredNulls.add(key)
    }
    const declaredIndexes = new Set<string>()
    for (const rule of contribution.indexUniqueNulls ?? []) {
      const index = contribution.tables
        .find((table) => table.id === rule.table)
        ?.indexes.find((index) => index.name === rule.index)
      const key = JSON.stringify([rule.table, rule.index])
      if (
        !index?.unique ||
        !['distinct', 'not-distinct'].includes(rule.nulls) ||
        declaredIndexes.has(key)
      )
        throw new Error('RFC-395 invalid or duplicate index unique NULL semantics')
      declaredIndexes.add(key)
    }
    for (const declared of contribution.tables) {
      const table = resolveColumnUniqueNulls(registry, declared)
      if (!table.owner?.trim() || table.owner !== contribution.owner)
        throw new Error(`RFC-395 missing or mismatched owner: ${table.id}`)
      if (byId.has(table.id) || symbols.has(table.schemaSymbol))
        throw new Error(`RFC-395 duplicate table: ${table.id}`)
      if (Object.hasOwn(table, 'triggers'))
        throw new Error('RFC-395 untyped triggers are forbidden')
      byId.set(table.id, declared)
      symbols.add(table.schemaSymbol)
      const names = Object.values(table.columns).map((column) => column.name)
      if (new Set(names).size !== names.length)
        throw new Error(`RFC-395 duplicate column: ${table.id}`)
      for (const column of Object.values(table.columns)) {
        if (!column.codec || !Object.hasOwn(CODECS, column.codec))
          throw new Error(`RFC-395 missing codec: ${table.id}.${column.name}`)
        if (column.document && column.codec !== 'jsonText')
          throw new Error('RFC-395 versioned document requires byte-preserving jsonText')
        const document = column.document
        if (
          document?.kind === 'content-ref' &&
          !Object.values(table.columns).some(
            (companion) =>
              companion.name === document.inlineBytesColumn && companion.codec === 'bytes',
          )
        )
          throw new Error('RFC-395 ContentRef requires an inline bytes column')
        if (column.codec === 'jsonDoc' && column.originalTextDigest)
          throw new Error(
            `RFC-395 jsonDoc violates original-text digest: ${table.id}.${column.name}`,
          )
        if ((column.codec === 'identity' || column.codec === 'seq') && !column.highWater)
          throw new Error(
            `RFC-395 identity/seq missing high-water policy: ${table.id}.${column.name}`,
          )
        if (
          (registry.schemaEpoch ?? 1) > 1 &&
          column.unique &&
          column.nullable &&
          !column.uniqueNulls
        )
          throw new Error(
            `RFC-395 nullable unique requires explicit NULL semantics: ${table.id}.${column.name}`,
          )
        if (column.uniqueNulls && !['distinct', 'not-distinct'].includes(column.uniqueNulls))
          throw new Error('RFC-395 unknown unique NULL semantics')
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
      for (const unique of table.unique) {
        if (!unique.columns.length || unique.columns.some((name) => !names.includes(name)))
          throw new Error(`RFC-395 invalid unique columns: ${table.id}`)
        if (!['distinct', 'not-distinct'].includes(unique.nulls))
          throw new Error(`RFC-395 unique requires explicit NULL semantics: ${table.id}`)
      }
      for (const index of table.indexes) {
        if (
          (registry.schemaEpoch ?? 1) > 1 &&
          index.unique &&
          hasImplicitIndexNulls(index) &&
          index.columns.some(
            (expression) =>
              expression.kind !== 'column' ||
              Object.values(table.columns).some(
                (column) => column.name === expression.name && column.nullable,
              ),
          )
        )
          throw new Error(
            `RFC-395 nullable unique index requires explicit NULL semantics: ${table.id}.${index.name}`,
          )
        if (index.unique && !['distinct', 'not-distinct'].includes(index.nulls))
          throw new Error(`RFC-395 unique index requires explicit NULL semantics: ${table.id}`)
        for (const expression of index.columns)
          if (expression.kind === 'column' && !names.includes(expression.name))
            throw new Error(`RFC-395 invalid index column: ${table.id}.${expression.name}`)
      }
      for (const rule of table.rowRules ?? []) {
        if (!rule.errorCode?.trim()) throw new Error('RFC-395 row rule requires one error code')
        if (rule.kind === 'immutableOnceSet') {
          if (!rule.columns.length || rule.columns.some((name) => !names.includes(name)))
            throw new Error('RFC-395 invalid immutable columns')
          validateRowCondition(rule.when, names)
        } else if (rule.kind !== 'appendOnly' || rule.table !== table.id)
          throw new Error('RFC-395 untyped row rule is forbidden')
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
  if (registry.contributions.some((contribution) => contribution.seeds?.length))
    compileInstallSeeds(registry, { path: 'test-baseline', installedAt: 0 })
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
