// RFC-395 I-b: the measured common query vocabulary, implemented by native Drizzle objects.
import type {
  Column,
  ColumnsSelection,
  Assume,
  GetColumnData,
  InferInsertModel,
  Placeholder,
  Query,
  SQL,
  SQLWrapper,
  Subquery,
  Table,
  TableConfig,
  ValidateShape,
} from 'drizzle-orm'
import type { SelectedFields } from 'drizzle-orm/operations'
import type { TypedQueryBuilder } from 'drizzle-orm/query-builders/query-builder'
import type {
  AppendToNullabilityMap,
  AppendToResult,
  BuildSubquerySelection,
  JoinNullability,
  GetSelectTableName,
  GetSelectTableSelection,
  SelectMode,
  SelectResult,
  SelectResultFields,
} from 'drizzle-orm/query-builders/select.types'

// Drizzle's upsert target carries a dialect brand in its extra type configuration.
// Erase that brand at the input boundary; inferred selections retain their concrete column types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PersistenceColumn = Column<any, any, any>
export type PersistenceTable = Table
export type PersistenceFields = SelectedFields<PersistenceColumn, Table>
type OrderColumn = PersistenceColumn | SQL | SQL.Aliased
type Nullability = Record<string, JoinNullability>
type InitialNullability<N extends string | undefined> = N extends string
  ? Record<N, 'not-null'>
  : Record<never, never>
type SetOperatorClauses = 'where' | 'having' | 'groupBy' | 'innerJoin' | 'leftJoin'
interface QueryResult<R> extends Promise<R>, SQLWrapper {
  toSQL(): Query
}

// Keep result and subquery selection as separate parameters, as Drizzle's HKT does.
// Clauses preserve those parameters; a join computes a new nullability map and selection.
export type PersistenceSelect<
  TName extends string | undefined,
  F extends ColumnsSelection,
  Mode extends SelectMode,
  N extends Nullability = InitialNullability<TName>,
  Excluded extends string = never,
  R extends unknown[] = SelectResult<F, Mode, N>[],
  S extends ColumnsSelection = BuildSubquerySelection<F, N>,
> = Omit<SelectQuery<TName, F, Mode, N, Excluded, R, S>, Excluded>

type Clause<
  TName extends string | undefined,
  F extends ColumnsSelection,
  Mode extends SelectMode,
  N extends Nullability,
  Excluded extends string,
  R extends unknown[],
  S extends ColumnsSelection,
> = PersistenceSelect<
  TName,
  Assume<F, ColumnsSelection>,
  Mode,
  Assume<N, Nullability>,
  Excluded,
  R,
  Assume<S, ColumnsSelection>
>
type Joined<
  TName extends string | undefined,
  F extends ColumnsSelection,
  Mode extends SelectMode,
  N extends Nullability,
  Excluded extends string,
  J extends string | undefined,
  Fields extends SelectedFields<Column, Table>,
  Kind extends 'left' | 'inner' | 'cross',
> = Clause<
  TName,
  AppendToResult<TName, F, J, Fields, Mode>,
  Mode extends 'partial' ? Mode : 'multiple',
  AppendToNullabilityMap<N, J, Kind>,
  Excluded,
  SelectResult<
    AppendToResult<TName, F, J, Fields, Mode>,
    Mode extends 'partial' ? Mode : 'multiple',
    AppendToNullabilityMap<N, J, Kind>
  >[],
  BuildSubquerySelection<
    AppendToResult<TName, F, J, Fields, Mode>,
    AppendToNullabilityMap<N, J, Kind>
  >
>

interface SelectQuery<
  TName extends string | undefined,
  F extends ColumnsSelection,
  Mode extends SelectMode,
  N extends Nullability,
  Excluded extends string,
  R extends unknown[],
  S extends ColumnsSelection,
> extends QueryResult<R> {
  readonly _: { readonly selectedFields: S; readonly result: R }
  where(
    condition: SQL | undefined | ((fields: F) => SQL | undefined),
  ): Clause<TName, F, Mode, N, Excluded | 'where', R, S>
  having(
    condition: SQL | undefined | ((fields: F) => SQL | undefined),
  ): Clause<TName, F, Mode, N, Excluded | 'having', R, S>
  groupBy(...columns: OrderColumn[]): Clause<TName, F, Mode, N, Excluded | 'groupBy', R, S>
  orderBy(...columns: OrderColumn[]): Clause<TName, F, Mode, N, Excluded | 'orderBy', R, S>
  limit(count: number | Placeholder): Clause<TName, F, Mode, N, Excluded | 'limit', R, S>
  offset(count: number | Placeholder): Clause<TName, F, Mode, N, Excluded | 'offset', R, S>
  innerJoin<C extends TableConfig<PersistenceColumn>>(
    table: Table<C>,
    on: SQL | undefined | ((fields: F) => SQL | undefined),
  ): Joined<
    TName,
    F,
    Mode,
    N,
    Excluded,
    GetSelectTableName<Table<C>>,
    GetSelectTableSelection<Table<C>>,
    'inner'
  >
  leftJoin<C extends TableConfig<PersistenceColumn>>(
    table: Table<C>,
    on: SQL | undefined | ((fields: F) => SQL | undefined),
  ): Joined<
    TName,
    F,
    Mode,
    N,
    Excluded,
    GetSelectTableName<Table<C>>,
    GetSelectTableSelection<Table<C>>,
    'left'
  >
  crossJoin<C extends TableConfig<PersistenceColumn>>(
    table: Table<C>,
  ): Joined<
    TName,
    F,
    Mode,
    N,
    Excluded,
    GetSelectTableName<Table<C>>,
    GetSelectTableSelection<Table<C>>,
    'cross'
  >
  unionAll(
    right: ValidateShape<R[number], R[number], TypedQueryBuilder<unknown, R>>,
  ): Clause<TName, F, Mode, N, SetOperatorClauses, R, S>
}
interface SelectFrom<F extends PersistenceFields | undefined> {
  from<T extends Table>(
    source: T,
  ): PersistenceSelect<
    GetSelectTableName<T>,
    F extends undefined ? GetSelectTableSelection<T> : Exclude<F, undefined>,
    F extends undefined ? 'single' : 'partial'
  >
  from(
    source: SQL,
  ): PersistenceSelect<
    undefined,
    F extends undefined ? Record<never, never> : Exclude<F, undefined>,
    F extends undefined ? 'single' : 'partial'
  >
}

type InsertValues<T extends Table> = {
  [P in keyof InferInsertModel<T>]: InferInsertModel<T>[P] | SQL | Placeholder
}
type UpdateValues<T extends Table> = {
  [P in keyof T['_']['columns']]?:
    | GetColumnData<T['_']['columns'][P]>
    | SQL
    | PersistenceColumn
    | undefined
}
type ReturningFields = Record<string, PersistenceColumn | SQL | SQL.Aliased | Subquery>
/** Native mutation results; Drizzle types bun:sqlite's run result as void. */
export type PersistenceWriteResult = void | { readonly changes?: number; readonly count?: number }
type MutationResult<R> = R extends undefined ? PersistenceWriteResult : R[]
type ConflictClauses = 'onConflictDoNothing' | 'onConflictDoUpdate'
type InsertQuery<T extends Table, R = undefined, Excluded extends string = never> = Omit<
  InsertStatement<T, R, Excluded>,
  Excluded
>
interface InsertStatement<T extends Table, R, Excluded extends string> extends QueryResult<
  MutationResult<R>
> {
  onConflictDoNothing(config?: {
    target?: PersistenceColumn | PersistenceColumn[]
    where?: SQL
  }): InsertQuery<T, R, Excluded | ConflictClauses>
  onConflictDoUpdate(config: {
    target: PersistenceColumn | PersistenceColumn[]
    set: UpdateValues<T>
    where?: SQL
    targetWhere?: SQL
    setWhere?: SQL
  }): InsertQuery<T, R, Excluded | ConflictClauses>
  returning(): InsertQuery<T, T['$inferSelect'], Excluded | 'returning'>
  returning<F extends ReturningFields>(
    fields: F,
  ): InsertQuery<T, SelectResultFields<F>, Excluded | 'returning'>
}
interface InsertBuilder<T extends Table> {
  values(value: InsertValues<T>): InsertQuery<T>
  values(values: InsertValues<T>[]): InsertQuery<T>
}

type WriteQuery<T extends Table, R = undefined, Excluded extends string = never> = Omit<
  WriteStatement<T, R, Excluded>,
  Excluded
>
interface WriteStatement<T extends Table, R, Excluded extends string> extends QueryResult<
  MutationResult<R>
> {
  where(condition: SQL | undefined): WriteQuery<T, R, Excluded | 'where'>
  returning(): WriteQuery<T, T['$inferSelect'], Excluded | 'returning'>
  returning<F extends ReturningFields>(
    fields: F,
  ): WriteQuery<T, SelectResultFields<F>, Excluded | 'returning'>
}

/** Native bun-sqlite and bun-sql databases and transactions implement this interface. */
export interface PersistenceDb {
  select(): SelectFrom<undefined>
  select<F extends PersistenceFields>(fields: F): SelectFrom<F>
  selectDistinct(): SelectFrom<undefined>
  selectDistinct<F extends PersistenceFields>(fields: F): SelectFrom<F>
  insert<T extends Table>(table: T): InsertBuilder<T>
  update<T extends Table>(table: T): { set(values: UpdateValues<T>): WriteQuery<T> }
  delete<T extends Table>(table: T): WriteQuery<T>
}
export type PersistenceTx = PersistenceDb
