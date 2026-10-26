// RFC-395 II-a A1: shared fixture transport; aggregate adapters keep target writes in the caller transaction.
import {
  and,
  getTableColumns,
  eq,
  isNull,
  inArray,
  type SQL,
  type Table,
  or,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  notInArray,
  isNotNull,
  asc,
  desc,
  sql,
} from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
} from '@/platform/persistence/databaseTransaction'
import { affectedRows } from '@/platform/persistence/queryHelpers'
import { insertOne, type PersistenceInsertValues } from '@/platform/persistence/singleInsert'
import type { PersistenceColumn } from '@/platform/persistence/querySurface'
import inventory from '../../fixtures/rfc395-column-destinations.json'

export type FixtureHandle = PersistenceDb | PersistenceTx
/** JSON text is preserved byte-for-byte; values are encoded exactly once. */
export type FixtureJson = string | object | number | boolean | null
export type FixturePatch<S> = {
  [K in keyof S]?: S[K] | (Exclude<S[K], undefined> extends never ? never : SQL)
}
export type FixtureWhere<S> = Partial<S>
export interface FixtureReadOptions<R> {
  orderBy?: readonly {
    field: keyof R & string
    direction?: 'asc' | 'desc'
    nulls?: 'first' | 'last'
  }[]
  limit?: number
  offset?: number
}
export interface FixtureOptions {
  onConflict?: 'ignore'
}
export const fixtureId = (): string => ulid()
export function fixtureRows<S>(input: S | readonly S[]): readonly S[] {
  return Array.isArray(input) ? input : [input as S]
}
export function fixtureTransaction<T>(
  db: FixtureHandle,
  body: (tx: PersistenceTx) => Promise<T>,
): Promise<T> {
  // A caller-owned transaction must also own the sequence allocation and every aggregate row.
  return databaseTransactionIsActive(db) ? body(db) : databaseSessionFor(db).transaction(body)
}
export function fixtureJson(value: FixtureJson): string | null {
  return value === null || typeof value === 'string' ? value : JSON.stringify(value)
}
export function encodeFixture(table: string, spec: object): Record<string, unknown> {
  const input = spec as Record<string, unknown>
  const row: Record<string, unknown> = {}
  for (const entry of inventory.columns) {
    if (
      entry.table !== table ||
      ['checkpoints', 'consumedEdges', 'repos'].includes(entry.spec) ||
      entry.target === 'deleted-shape'
    )
      continue
    const value = input[entry.spec]
    if (value !== undefined)
      row[entry.property] =
        'json' in entry && entry.json && !(value instanceof Object && 'getSQL' in value)
          ? fixtureJson(value as FixtureJson)
          : value
  }
  return row
}
/** Projection names; JSON text stays available for tests asserting exact stored payload bytes. */
export function decodeFixture(table: string, row: object): Record<string, unknown> {
  const stored = row as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const entry of inventory.columns) {
    if (
      entry.table !== table ||
      ['checkpoints', 'consumedEdges', 'repos'].includes(entry.spec) ||
      entry.target === 'deleted-shape'
    )
      continue
    result[entry.spec] = stored[entry.property]
  }
  return result
}
export function fixturePredicate<T extends Table>(
  table: T,
  physicalTable: string,
  where: object | undefined,
): SQL | undefined {
  if (!where) return undefined
  const columns = table as unknown as Record<string, PersistenceColumn>
  const entries = inventory.columns.filter((entry) => entry.table === physicalTable)
  const column = (key: string) => {
    const entry = entries.find((entry) => entry.spec === key)
    if (!((entry?.property ?? key) in columns))
      throw new Error('Unsupported fixture predicate: ' + key)
    return columns[entry?.property ?? key]!
  }
  return and(
    ...Object.entries(where).map(([key, value]) => {
      if (key === '$and' || key === '$or') {
        const children = (value as object[]).map((item) =>
          fixturePredicate(table, physicalTable, item),
        )
        return key === '$and' ? and(...children) : or(...children)
      }
      const field = column(key)
      if (value === null) return isNull(field)
      if (Array.isArray(value)) return inArray(field, value)
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        return and(
          ...Object.entries(value).map(([operator, operand]) => {
            switch (operator) {
              case '$ne':
                return operand === null ? isNotNull(field) : ne(field, operand)
              case '$gt':
                return gt(field, operand)
              case '$gte':
                return gte(field, operand)
              case '$lt':
                return lt(field, operand)
              case '$lte':
                return lte(field, operand)
              case '$like':
                return like(field, operand as string)
              case '$in':
                return inArray(field, operand as unknown[])
              case '$notIn':
                return notInArray(field, operand as unknown[])
              default:
                throw new Error('Unsupported fixture operator: ' + operator)
            }
          }),
        )
      }
      return eq(field, value)
    }),
  )
}
export async function insertFixtureRow<T extends Table>(
  db: FixtureHandle,
  table: T,
  row: Record<string, unknown>,
  options: FixtureOptions,
): Promise<boolean> {
  const values = physicalFixtureValues(table, row) as PersistenceInsertValues<T>
  const result =
    options.onConflict === 'ignore'
      ? await db.insert(table).values(values).onConflictDoNothing()
      : await insertOne(db, table, values)
  return affectedRows(result) > 0
}
export async function patchFixtureRows<T extends Table>(
  db: FixtureHandle,
  table: T,
  physicalTable: string,
  where: object | undefined,
  patch: Record<string, unknown>,
): Promise<number> {
  const update = db.update(table)
  return affectedRows(
    await update
      .set(patch as Parameters<typeof update.set>[0])
      .where(fixturePredicate(table, physicalTable, where)),
  )
}

export function physicalFixtureValues<T extends Table>(
  table: T,
  values: object,
): Record<string, unknown> {
  const columns = getTableColumns(table)
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => key in columns && value !== undefined),
  )
}

interface FixtureAdapter<S extends object, T extends Table, R> {
  table(db: FixtureHandle): T
  physicalTable: string
  columns?(db: FixtureHandle): object
  keys: readonly string[]
  prepare?(
    db: FixtureHandle,
    row: Record<string, unknown>,
    spec: S,
    batch: readonly S[],
  ): Promise<void>
  afterWrite?(db: FixtureHandle, row: T['$inferSelect'], spec: S): Promise<void>
  rootPatch?(
    row: T['$inferSelect'],
    values: FixturePatch<S>,
    encoded: Record<string, unknown>,
  ): Record<string, unknown>
  afterPatch?(db: FixtureHandle, row: T['$inferSelect'], spec: FixturePatch<S>): Promise<void>
  project(db: FixtureHandle, row: T['$inferSelect']): Promise<R>
}
export function createFixtureAdapter<S extends object, T extends Table, R>(
  adapter: FixtureAdapter<S, T, R>,
) {
  const readRows = async (
    db: FixtureHandle,
    where?: object,
    options: FixtureReadOptions<R> = {},
  ): Promise<R[]> => {
    const table = adapter.table(db)
    const columns = (adapter.columns?.(db) ?? table) as Record<string, PersistenceColumn>
    const order = (options.orderBy ?? []).map(({ field, direction = 'asc', nulls }) => {
      const entry = inventory.columns.find(
        (entry) => entry.table === adapter.physicalTable && entry.spec === field,
      )
      if (!entry || !(entry.property in columns))
        throw new Error('Unsupported fixture ordering: ' + field)
      const expression =
        direction === 'desc' ? desc(columns[entry.property]!) : asc(columns[entry.property]!)
      return nulls === 'first'
        ? sql`${expression} nulls first`
        : nulls === 'last'
          ? sql`${expression} nulls last`
          : expression
    })
    const query = db
      .select()
      .from(table)
      .where(fixturePredicate(columns as unknown as T, adapter.physicalTable, where))
      .orderBy(...order)
    const limited = options.limit === undefined ? query : query.limit(options.limit)
    const rows = await (options.offset === undefined ? limited : limited.offset(options.offset))
    return Promise.all(rows.map((row) => adapter.project(db, row)))
  }
  const read = (
    db: FixtureHandle,
    where?: object,
    options: FixtureReadOptions<R> = {},
  ): Promise<R[]> =>
    databaseTransactionIsActive(db)
      ? readRows(db, where, options)
      : databaseSessionFor(db).snapshotRead((tx) => readRows(tx, where, options))
  const insert = async (
    db: FixtureHandle,
    input: S | readonly S[],
    options: FixtureOptions = {},
  ): Promise<R[]> =>
    fixtureTransaction(db, async (tx) => {
      const table = adapter.table(tx)
      const result: R[] = []
      for (const spec of fixtureRows(input)) {
        const row = encodeFixture(adapter.physicalTable, spec)
        if (adapter.keys.includes('id')) row.id ??= fixtureId()
        await adapter.prepare?.(tx, row, spec, fixtureRows(input))
        if (!(await insertFixtureRow(tx, table, row, options))) continue
        const where = Object.fromEntries(adapter.keys.map((key) => [key, row[key]]))
        const stored = await tx
          .select()
          .from(table)
          .where(fixturePredicate(table, adapter.physicalTable, where))
        if (!stored[0]) throw new Error('Fixture insert did not return its row')
        await adapter.afterWrite?.(tx, stored[0], spec)
        result.push(await adapter.project(tx, stored[0]))
      }
      return result
    })
  const patch = async (
    db: FixtureHandle,
    where: object | undefined,
    values: FixturePatch<S>,
  ): Promise<number> => {
    return fixtureTransaction(db, async (tx) => {
      const table = adapter.table(tx)
      const columns = adapter.columns?.(tx) ?? table
      const rows = await tx
        .select()
        .from(table)
        .where(fixturePredicate(columns as T, adapter.physicalTable, where))
      const encoded = encodeFixture(adapter.physicalTable, values)
      for (const row of rows) {
        const patch = physicalFixtureValues(
          table,
          adapter.rootPatch?.(row, values, encoded) ?? encoded,
        )
        const key = Object.fromEntries(
          adapter.keys.map((name) => [name, (row as Record<string, unknown>)[name]]),
        )
        if (Object.keys(patch).length)
          await patchFixtureRows(tx, table, adapter.physicalTable, key, patch)
        await adapter.afterPatch?.(tx, row, values)
      }
      return rows.length
    })
  }
  return { insert, read, patch }
}
