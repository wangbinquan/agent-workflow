// RFC-395 I-b: semantic table types shared by the two native Drizzle materializations.
import type { Column, ColumnBaseConfig, ColumnDataType, Table } from 'drizzle-orm'
import type { CodecData } from './codecs'
import type { ColumnDefinition, TableDefinition } from './contribution'

export type ColumnData<C extends ColumnDefinition> = C extends {
  enumValues: readonly (infer E extends string)[]
}
  ? E
  : CodecData<C['codec']>

/** Driver representation and dialect brands do not belong to a business column. */
export type NeutralColumnConfig<T extends string, C extends ColumnDefinition> = Omit<
  ColumnBaseConfig<ColumnDataType, string>,
  'name' | 'tableName' | 'data' | 'notNull' | 'hasDefault'
> & {
  name: C['name']
  tableName: T
  data: ColumnData<C>
  notNull: C['nullable'] extends false ? true : false
  hasDefault: C['default']['kind'] extends 'none' ? false : true
  generated: undefined
  identity: undefined
}

// The dialect brand is deliberately erased, while data/notNull/default stay precise.
// This also lets legacy native sync queries consume a session-derived projection.
export type DialectNeutralColumn<C extends ColumnBaseConfig<ColumnDataType, string>> = Column<
  C,
  object,
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dialect: any
  }
> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly table: Table<any>
}
export type NeutralColumn<T extends string, C extends ColumnDefinition> = DialectNeutralColumn<
  NeutralColumnConfig<T, C>
>
export type NeutralColumns<D extends TableDefinition> = {
  -readonly [P in keyof D['columns']]: NeutralColumn<D['id'], D['columns'][P]>
}
export type NeutralTable<D extends TableDefinition> = Table<{
  name: D['id']
  schema: string | undefined
  dialect: string
  columns: NeutralColumns<D>
}> &
  NeutralColumns<D>

/** A full table set is injected into a session; module-only subsets are RFC-395 T11. */
export type NeutralTableSet<T extends readonly TableDefinition[]> = {
  readonly [D in T[number] as D['schemaSymbol']]: NeutralTable<D>
}
