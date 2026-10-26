// RFC-395 I-b: materialize independent native tables for each provider.
import { sql, type SQL, type SQLChunk } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
  unique,
  check,
  primaryKey,
  foreignKey,
  customType as sqliteCustomType,
  type SQLiteColumn,
  type SQLiteColumnBuilderBase,
  type SQLiteTableWithColumns,
  type AnySQLiteColumn,
  type SQLiteTableExtraConfigValue,
} from 'drizzle-orm/sqlite-core'
import {
  pgSchema,
  text as pgText,
  boolean as pgBoolean,
  bigint as pgBigint,
  bigserial,
  doublePrecision,
  customType,
  jsonb,
  type AnyPgTable,
  type PgColumn,
  type PgTableWithColumns,
  type PgColumnBuilderBase,
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  unique as pgUnique,
  primaryKey as pgPrimaryKey,
  foreignKey as pgForeignKey,
  check as pgCheck,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import type { DatabaseProvider } from '../databaseProviders'
import { CODECS, type CodecData } from './codecs'
import type { ColumnDefinition, TableDefinition } from './contribution'
import { renderSchemaExpression, type SchemaExpression } from './expressions'
import { targetCodecChecks, sqliteNullsNotDistinct } from './nativeConstraints'
import type { NeutralColumnConfig } from './neutral'

type ColumnData<C extends ColumnDefinition> = C extends {
  enumValues: readonly (infer E extends string)[]
}
  ? E
  : CodecData<C['codec']>
type MaterializedColumn<T extends string, C extends ColumnDefinition> = SQLiteColumn<{
  name: C['name']
  tableName: T
  dataType: (typeof CODECS)[C['codec']]['dataType']
  columnType: C['codec'] extends 'bool'
    ? 'SQLiteBoolean'
    : C['codec'] extends 'real'
      ? 'SQLiteReal'
      : C['codec'] extends 'bytes'
        ? 'SQLiteBlobBuffer'
        : (typeof CODECS)[C['codec']]['sqlite'] extends 'integer'
          ? 'SQLiteInteger'
          : 'SQLiteText'
  data: ColumnData<C>
  driverParam: string | number | boolean | Buffer | bigint
  notNull: C['nullable'] extends false ? true : false
  hasDefault: C['default']['kind'] extends 'none' ? false : true
  isPrimaryKey: C['primary']
  isAutoincrement: C['codec'] extends 'identity' ? true : false
  generated: undefined
  identity: undefined
  hasRuntimeDefault: false
  enumValues: [string, ...string[]]
}>
export type MaterializedTable<D extends TableDefinition> = SQLiteTableWithColumns<{
  name: D['id']
  schema: undefined
  dialect: 'sqlite'
  columns: { -readonly [P in keyof D['columns']]: MaterializedColumn<D['id'], D['columns'][P]> }
}>
/** Both provider projections retain the contract's literal row and insert types. */
export type MaterializedPostgresqlTable<D extends TableDefinition> = PgTableWithColumns<{
  name: D['id']
  schema: 'agent_workflow'
  dialect: 'pg'
  columns: {
    -readonly [P in keyof D['columns']]: PgColumn<NeutralColumnConfig<D['id'], D['columns'][P]>>
  }
}>

interface Builder {
  notNull(): Builder
  primaryKey(options?: { autoIncrement: boolean }): Builder
  default(value: unknown): Builder
  unique(name: string): Builder
}
const sqliteBigint = sqliteCustomType<{ data: bigint; driverData: bigint }>({
  dataType: () => 'integer',
})
const applicationSchema = pgSchema('agent_workflow')
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
})
function sqliteBuilder(column: ColumnDefinition): Builder {
  const codec = CODECS[column.codec]
  if (column.codec === 'bool') return integer(column.name, { mode: 'boolean' })
  if (column.codec === 'jsonDoc') return text(column.name, { mode: 'json' })
  if (column.codec === 'bigint') return sqliteBigint(column.name)
  if (codec.sqlite === 'integer') return integer(column.name)
  if (codec.sqlite === 'real') return real(column.name)
  if (codec.sqlite === 'blob') return blob(column.name, { mode: 'buffer' })
  return column.enumValues?.length
    ? text(column.name, { enum: [...column.enumValues] as [string, ...string[]] })
    : text(column.name)
}
function postgresqlBuilder(column: ColumnDefinition): Builder {
  const codec = CODECS[column.codec]
  // Keep the descriptor's identity metadata; native pg-core renders DEFAULT for omitted
  // values. Physical identity DDL remains owned by the unchanged migration contract.
  if (column.codec === 'identity')
    return bigserial(column.name, { mode: 'number' }).default(sql`default`)
  if (codec.postgresql === 'boolean') return pgBoolean(column.name)
  if (codec.postgresql === 'bigint')
    return column.codec === 'bigint'
      ? pgBigint(column.name, { mode: 'bigint' })
      : pgBigint(column.name, { mode: 'number' })
  if (codec.postgresql === 'double precision') return doublePrecision(column.name)
  if (codec.postgresql === 'bytea') return bytea(column.name)
  if (codec.postgresql === 'jsonb') return jsonb(column.name)
  return column.enumValues?.length
    ? pgText(column.name, { enum: [...column.enumValues] as [string, ...string[]] })
    : pgText(column.name)
}
interface ColumnRules {
  readonly build: (column: ColumnDefinition) => Builder
  readonly primary: (builder: Builder, column: ColumnDefinition) => Builder
  readonly implicitDefault: boolean
}
const COLUMN_RULES = {
  sqlite: {
    build: sqliteBuilder,
    primary: (builder, column) =>
      builder.primaryKey({ autoIncrement: column.codec === 'identity' }),
    implicitDefault: false,
  },
  postgresql: {
    build: postgresqlBuilder,
    primary: (builder) => builder.primaryKey(),
    implicitDefault: true,
  },
} satisfies Record<DatabaseProvider, ColumnRules>
function configureColumn(column: ColumnDefinition, provider: DatabaseProvider): Builder {
  const rules: ColumnRules = COLUMN_RULES[provider]
  let builder = rules.build(column)
  if (!column.nullable) builder = builder.notNull()
  if (column.primary) builder = rules.primary(builder, column)
  if (column.unique && column.uniqueNulls !== 'not-distinct')
    builder = builder.unique(column.unique)
  if (
    rules.implicitDefault &&
    column.default.kind === 'implicit-primary' &&
    column.codec !== 'identity'
  )
    builder = builder.default(undefined)
  if (column.default.kind === 'literal') builder = builder.default(column.default.value)
  if (column.default.kind === 'expression')
    builder = builder.default(sql.raw(renderSchemaExpression(column.default.expression, provider)))
  return builder
}
interface Materialization {
  readonly sqlite: object
  readonly postgresql: AnyPgTable
  readonly table: object
}
const cache = new WeakMap<TableDefinition, Materialization>()
const targetCache = new WeakMap<TableDefinition, Materialization>()
export function materializeDrizzle<const D extends TableDefinition>(
  definition: D,
  options: { readonly schemaEpoch?: number } = {},
): {
  readonly sqlite: MaterializedTable<D>
  readonly postgresql: MaterializedPostgresqlTable<D>
  readonly table: MaterializedTable<D>
} {
  const selectedCache = (options.schemaEpoch ?? 1) > 1 ? targetCache : cache
  const cached = selectedCache.get(definition)
  if (cached) return cached as ReturnType<typeof materializeDrizzle<D>>
  const columns = Object.fromEntries(
    Object.entries(definition.columns).map(([property, column]) => [
      property,
      configureColumn(column, 'sqlite'),
    ]),
  ) as unknown as Record<string, SQLiteColumnBuilderBase>
  const sqlite = sqliteTable(definition.id, columns, (self) => {
    const byName = new Map(Object.values(self).map((column) => [column.name, column]))
    const ownColumn = (name: string): AnySQLiteColumn => {
      const column = byName.get(name)
      if (!column) throw new Error(`RFC-395 missing column ${definition.id}.${name}`)
      return column
    }
    const expressionSql = (expression: SchemaExpression): SQL => {
      const rendered = renderSchemaExpression(expression, 'sqlite')
      const chunks: SQLChunk[] = []
      const reference = new RegExp('"' + definition.id + '"\\."([^"\\n]+)"', 'g')
      let cursor = 0
      for (const match of rendered.matchAll(reference)) {
        chunks.push(sql.raw(rendered.slice(cursor, match.index)), ownColumn(match[1]!))
        cursor = match.index + match[0].length
      }
      chunks.push(sql.raw(rendered.slice(cursor)))
      return sql.join(chunks, sql.empty())
    }
    const expressions = (
      items: readonly { kind: string }[],
    ): [AnySQLiteColumn | SQL, ...(AnySQLiteColumn | SQL)[]] =>
      items.map((item) => {
        const expression = item as (typeof definition.indexes)[number]['columns'][number]
        return expression.kind === 'column' ? ownColumn(expression.name) : expressionSql(expression)
      }) as [AnySQLiteColumn | SQL, ...(AnySQLiteColumn | SQL)[]]
    const extras: SQLiteTableExtraConfigValue[] = []
    for (const entry of definition.indexes) {
      const items =
        entry.unique && entry.nulls === 'not-distinct'
          ? (sqliteNullsNotDistinct(
              entry.columns.map((column) => renderSchemaExpression(column, 'sqlite')),
            ).map((text) => sql.raw(text)) as [SQL, ...SQL[]])
          : expressions(entry.columns)
      let builder = (entry.unique ? uniqueIndex(entry.name) : index(entry.name)).on(...items)
      if (entry.where) builder = builder.where(expressionSql(entry.where))
      extras.push(builder)
    }
    if (!Object.values(definition.columns).some((column) => column.primary))
      extras.push(
        primaryKey({
          columns: definition.primaryKey.map(ownColumn) as [AnySQLiteColumn, ...AnySQLiteColumn[]],
        }),
      )
    for (const entry of definition.unique.filter((entry) => entry.nulls !== 'not-distinct'))
      extras.push(
        unique(entry.name).on(
          ...(entry.columns.map(ownColumn) as [AnySQLiteColumn, ...AnySQLiteColumn[]]),
        ),
      )
    for (const key of [
      ...definition.unique.filter((entry) => entry.nulls === 'not-distinct'),
      ...Object.values(definition.columns)
        .filter((column) => column.unique && column.uniqueNulls === 'not-distinct')
        .map((column) => ({ name: column.unique!, columns: [column.name] })),
    ])
      extras.push(
        uniqueIndex(key.name).on(
          ...(sqliteNullsNotDistinct(key.columns.map((name) => `"${name}"`)).map((text) =>
            sql.raw(text),
          ) as [SQL, ...SQL[]]),
        ),
      )
    if ((options.schemaEpoch ?? 1) > 1)
      for (const entry of targetCodecChecks(definition, 'sqlite'))
        extras.push(check(entry.name, sql.raw(entry.sql)))
    for (const entry of definition.checks)
      extras.push(check(entry.name, expressionSql(entry.expression)))
    for (const entry of definition.foreignKeys) {
      // Drizzle-kit needs reference names, not cross-context table imports. The
      // registry validates these logical references against the full target.
      const target = sqliteTable(
        entry.foreignTable,
        Object.fromEntries(entry.foreignColumns.map((name) => [name, text(name)])),
      )
      extras.push(
        foreignKey({
          name: entry.name,
          columns: entry.columns.map(ownColumn) as [AnySQLiteColumn, ...AnySQLiteColumn[]],
          foreignColumns: [
            target[entry.foreignColumns[0]!]!,
            ...entry.foreignColumns.slice(1).map((name) => target[name]!),
          ],
        })
          .onDelete(entry.onDelete)
          .onUpdate(entry.onUpdate),
      )
    }
    return extras
  })
  for (const [property, column] of Object.entries(definition.columns)) {
    if (column.sqliteUniqueName)
      Object.defineProperty(sqlite[property]!, 'uniqueName', { value: column.sqliteUniqueName })
  }
  const postgresql = applicationSchema.table(
    definition.id,
    Object.fromEntries(
      Object.entries(definition.columns).map(([property, column]) => [
        property,
        configureColumn(column, 'postgresql'),
      ]),
    ) as unknown as Record<string, PgColumnBuilderBase>,
    (self) => {
      if ((options.schemaEpoch ?? 1) === 1) return []
      const byName = new Map(Object.values(self).map((column) => [column.name, column]))
      const own = (name: string): AnyPgColumn => {
        const column = byName.get(name)
        if (!column) throw new Error(`RFC-395 missing column ${definition.id}.${name}`)
        return column
      }
      const extras: PgTableExtraConfigValue[] = []
      if (!Object.values(definition.columns).some((column) => column.primary))
        extras.push(
          pgPrimaryKey({
            columns: definition.primaryKey.map(own) as [AnyPgColumn, ...AnyPgColumn[]],
          }),
        )
      for (const key of [
        ...definition.unique,
        ...Object.values(definition.columns)
          .filter((column) => column.uniqueNulls === 'not-distinct')
          .map((column) => ({
            name: column.unique!,
            columns: [column.name],
            nulls: column.uniqueNulls,
          })),
      ]) {
        const unique = pgUnique(key.name).on(
          ...(key.columns.map(own) as [AnyPgColumn, ...AnyPgColumn[]]),
        )
        extras.push(key.nulls === 'not-distinct' ? unique.nullsNotDistinct() : unique)
      }
      for (const entry of definition.indexes) {
        // Drizzle's index API has no NULLS NOT DISTINCT flag; the plan emits the native flag.
        const columns = entry.columns.map((column) =>
          column.kind === 'column'
            ? own(column.name)
            : sql.raw(renderSchemaExpression(column, 'postgresql')),
        )
        let index = (entry.unique ? pgUniqueIndex(entry.name) : pgIndex(entry.name)).on(
          ...(columns as [AnyPgColumn | SQL, ...(AnyPgColumn | SQL)[]]),
        )
        if (entry.where)
          index = index.where(sql.raw(renderSchemaExpression(entry.where, 'postgresql')))
        extras.push(index)
      }
      for (const entry of definition.checks)
        extras.push(
          pgCheck(entry.name, sql.raw(renderSchemaExpression(entry.expression, 'postgresql'))),
        )
      for (const entry of targetCodecChecks(definition, 'postgresql'))
        extras.push(pgCheck(entry.name, sql.raw(entry.sql)))
      for (const entry of definition.foreignKeys) {
        const target = applicationSchema.table(
          entry.foreignTable,
          Object.fromEntries(entry.foreignColumns.map((name) => [name, pgText(name)])),
        )
        extras.push(
          pgForeignKey({
            name: entry.name,
            columns: entry.columns.map(own) as [AnyPgColumn, ...AnyPgColumn[]],
            foreignColumns: [
              target[entry.foreignColumns[0]!]!,
              ...entry.foreignColumns.slice(1).map((name) => target[name]!),
            ],
          })
            .onDelete(entry.onDelete)
            .onUpdate(entry.onUpdate),
        )
      }
      return extras
    },
  )
  const result = { sqlite, postgresql, table: sqlite }
  selectedCache.set(definition, result)
  return result as unknown as ReturnType<typeof materializeDrizzle<D>>
}
