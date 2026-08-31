// RFC-349 — one logical schema surface backed by two concrete Drizzle table
// projections. Existing application code keeps the strongly typed SQLite
// declarations while the process-wide provider fence swaps the runtime table
// and column objects to a separately constructed pgTable projection.

import { is, SQL, sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  PgColumn,
  pgSchema,
  text,
  type AnyPgTable,
  type PgColumnBuilderBase,
} from 'drizzle-orm/pg-core'
import {
  getTableConfig,
  SQLiteColumn,
  SQLiteSyncDialect,
  type AnySQLiteColumn,
  type SQLiteTableFn,
} from 'drizzle-orm/sqlite-core'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'

const applicationSchema = pgSchema('agent_workflow')
const pgBytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
})
const sqliteDialect = new SQLiteSyncDialect()
let activeProvider: DatabaseProvider = 'sqlite'

interface TableProjection {
  readonly sqlite: object
  readonly postgresql: AnyPgTable
}

const projectionByFacade = new WeakMap<object, TableProjection>()
const facadeByConcrete = new WeakMap<object, object>()

interface PgColumnBuilderFacade {
  notNull(): PgColumnBuilderFacade
  default(value: unknown): PgColumnBuilderFacade
  primaryKey(): PgColumnBuilderFacade
  unique(name?: string): PgColumnBuilderFacade
}

function renderSqliteDefault(value: SQL): string {
  return sqliteDialect.sqlToQuery(value).sql.replaceAll(/\s+/g, ' ').trim()
}

export function renderPostgresqlDatabaseDefault(value: SQL): string {
  const expression = renderSqliteDefault(value)
  if (/^\(?unixepoch\(\) \* 1000\)?$/i.test(expression)) {
    return '(extract(epoch from clock_timestamp()) * 1000)::bigint'
  }
  if (/^\(?lower\(hex\(randomblob\(16\)\)\)\)?$/i.test(expression)) {
    return 'md5(random()::text || clock_timestamp()::text)'
  }
  // Remaining committed defaults are literal/provider-neutral expressions.
  // The baseline projector independently validates this allowlist before DDL.
  return expression
}

function postgresqlDefaultExpression(value: SQL): SQL {
  return sql.raw(renderPostgresqlDatabaseDefault(value))
}

function pgBuilder(column: AnySQLiteColumn): PgColumnBuilderFacade {
  if ((column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement) {
    return bigserial(column.name, { mode: 'number' }) as unknown as PgColumnBuilderFacade
  }
  if (column.dataType === 'boolean') {
    return boolean(column.name) as unknown as PgColumnBuilderFacade
  }
  if (column.dataType === 'number') {
    return (column.columnType === 'SQLiteReal'
      ? doublePrecision(column.name)
      : bigint(column.name, { mode: 'number' })) as unknown as PgColumnBuilderFacade
  }
  if (column.dataType === 'buffer') {
    return pgBytea(column.name) as unknown as PgColumnBuilderFacade
  }
  return (column.enumValues?.length
    ? text(column.name, { enum: column.enumValues as [string, ...string[]] })
    : text(column.name)) as unknown as PgColumnBuilderFacade
}

function projectColumn(column: AnySQLiteColumn): PgColumnBuilderFacade {
  let builder = pgBuilder(column)
  if (column.notNull) builder = builder.notNull()
  if (column.primary) builder = builder.primaryKey()
  if (column.isUnique) builder = builder.unique(column.uniqueName)
  if (
    column.hasDefault &&
    !(column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement
  ) {
    builder = builder.default(
      is(column.default, SQL) ? postgresqlDefaultExpression(column.default) : column.default,
    )
  }
  return builder
}

function buildPostgresqlTable(sqliteTable: object): AnyPgTable {
  const config = getTableConfig(sqliteTable as Parameters<typeof getTableConfig>[0])
  const columns = Object.fromEntries(
    Object.entries(sqliteTable)
      .filter((entry): entry is [string, AnySQLiteColumn] => is(entry[1], SQLiteColumn))
      .map(([property, column]) => [property, projectColumn(column)]),
  )
  return applicationSchema.table(
    config.name,
    columns as unknown as Record<string, PgColumnBuilderBase>,
  ) as AnyPgTable
}

function projectionFor(value: object): TableProjection | undefined {
  const facade = projectionByFacade.has(value) ? value : facadeByConcrete.get(value)
  return facade === undefined ? undefined : projectionByFacade.get(facade)
}

export function concreteDatabaseTable<T extends object>(table: T, provider: DatabaseProvider): T {
  const projection = projectionFor(table)
  if (projection === undefined) return table
  return projection[provider] as T
}

export function concreteDatabaseColumn<T extends object>(column: T, provider: DatabaseProvider): T {
  const table = (column as { readonly table?: object }).table
  if (table === undefined) return column
  const projection = projectionFor(table)
  if (projection === undefined) return column
  const name = (column as { readonly name?: string }).name
  if (name === undefined) return column
  const concreteTable = projection[provider] as unknown as Record<string, unknown>
  const concreteColumns = Object.values(concreteTable).filter(
    (value): value is PgColumn | AnySQLiteColumn =>
      provider === 'postgresql' ? is(value, PgColumn) : is(value, SQLiteColumn),
  )
  return (concreteColumns.find((candidate) => candidate.name === name) ?? column) as T
}

/**
 * Set once during provider bootstrap. The returned disposer exists for isolated
 * unit tests; production treats a second, different selection as a fence error.
 */
export function selectDatabaseSchemaProvider(provider: DatabaseProvider): () => void {
  const previous = activeProvider
  activeProvider = provider
  return () => {
    activeProvider = previous
  }
}

export function currentDatabaseSchemaProvider(): DatabaseProvider {
  return activeProvider
}

export function providerAwareSqliteTable(physicalSqliteTable: SQLiteTableFn): SQLiteTableFn {
  return ((...args: Parameters<SQLiteTableFn>) => {
    const sqliteTable = physicalSqliteTable(...args)
    const postgresqlTable = buildPostgresqlTable(sqliteTable)
    const facade: object = new Proxy(sqliteTable, {
      get(_target, property, receiver) {
        const projection = projectionByFacade.get(facade)!
        return Reflect.get(projection[activeProvider], property, receiver)
      },
      getPrototypeOf() {
        const projection = projectionByFacade.get(facade)!
        return Reflect.getPrototypeOf(projection[activeProvider])
      },
    })
    const projection = { sqlite: sqliteTable, postgresql: postgresqlTable }
    projectionByFacade.set(facade, projection)
    facadeByConcrete.set(sqliteTable, facade)
    facadeByConcrete.set(postgresqlTable, facade)
    return facade
  }) as SQLiteTableFn
}
