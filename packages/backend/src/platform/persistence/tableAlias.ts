// RFC-395 I-b: native Drizzle aliasing with semantic, dialect-neutral column types.
import { aliasedTable } from 'drizzle-orm/alias'
import type { Column, ColumnsSelection, MakeColumnConfig, SQL, Table } from 'drizzle-orm'
import type { DialectNeutralColumn } from './schema/neutral'

// Drizzle's ChangeColumnTableName has no implementation for its 'common' dialect.
// Preserve the same configuration transform using the root Column type instead.
export type PersistenceSelectionAlias<F extends ColumnsSelection, A extends string> = {
  [K in keyof F]: F[K] extends Column
    ? DialectNeutralColumn<MakeColumnConfig<F[K]['_'], A>>
    : F[K] extends Table
      ? PersistenceSelectionAlias<F[K]['_']['columns'], A>
      : F[K] extends SQL | SQL.Aliased
        ? F[K]
        : F[K] extends ColumnsSelection
          ? PersistenceSelectionAlias<F[K], A>
          : never
}
type AliasedColumns<T extends Table, A extends string> = {
  [K in keyof T['_']['columns']]: DialectNeutralColumn<
    MakeColumnConfig<T['_']['columns'][K]['_'], A>
  >
}
export type PersistenceTableAlias<T extends Table, A extends string> = Table<{
  name: A
  schema: T['_']['schema']
  dialect: string
  columns: AliasedColumns<T, A>
}> &
  AliasedColumns<T, A>

export function alias<T extends Table, A extends string>(
  table: T,
  name: A,
): PersistenceTableAlias<T, A> {
  return aliasedTable(table, name) as unknown as PersistenceTableAlias<T, A>
}
