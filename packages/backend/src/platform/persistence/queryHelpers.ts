// RFC-395 I-b: terminal and raw-row helpers for the native provider query objects.
import { is, type SQL, type SQLWrapper } from 'drizzle-orm'
import { SQLiteSelectBase } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { PgSelectBase } from 'drizzle-orm/pg-core'
import type { PersistenceDb, PersistenceWriteResult } from './querySurface'
import type { CodecName } from './schema/codecs'
import type { ColumnDefinition } from './schema/contribution'

/** Selects stop at one row; a mutation with RETURNING still executes its entire write. */
export function first<R>(
  query: PromiseLike<R[]> & { readonly _: { readonly resultType: 'sync' } },
): R | undefined
export function first<R>(
  query: PromiseLike<R[]> & { readonly _: { readonly resultType: 'async' } },
): Promise<R | undefined>
export function first<R>(query: PromiseLike<R[]>): R | undefined | Promise<R | undefined>
export function first<R>(query: PromiseLike<R[]>): R | undefined | Promise<R | undefined> {
  const limited = is(query, SQLiteSelectBase) || is(query, PgSelectBase) ? query.limit(1) : query
  const native = limited as PromiseLike<R[]> & {
    get?: () => R | undefined | Promise<R | undefined>
  }
  return native.get ? native.get() : Promise.resolve(native).then((rows) => rows[0])
}

/** Legacy synchronous transaction programs keep their execution timing; async callers await the native query. */
export function queryRows<R>(
  query: PromiseLike<R[]> & { all(bindings?: Record<string, unknown>): R[] },
  bindings?: Record<string, unknown>,
): R[]
export function queryRows<R>(
  query: PromiseLike<R[]>,
  bindings?: Record<string, unknown>,
): R[] | PromiseLike<R[]>
export function queryRows<R>(
  query: PromiseLike<R[]>,
  bindings?: Record<string, unknown>,
): R[] | PromiseLike<R[]> {
  const native = query as PromiseLike<R[]> & {
    all?: (bindings?: Record<string, unknown>) => R[] | PromiseLike<R[]>
    execute?: (bindings?: Record<string, unknown>) => PromiseLike<R[]>
  }
  if (native.all) return native.all(bindings)
  return bindings === undefined ? Promise.resolve(native) : native.execute!(bindings)
}
export function queryWrite<Q extends PromiseLike<unknown> & { run(): unknown }>(
  query: Q,
): ReturnType<Q['run']>
export function queryWrite<R>(query: PromiseLike<R>): R | Promise<R>
export function queryWrite(query: PromiseLike<unknown>): unknown {
  const native = query as PromiseLike<unknown> & { run?: () => unknown }
  return native.run ? native.run() : Promise.resolve(native)
}

/** bun:sqlite reports changes; Bun.SQL reports count on its result array. */
export function affectedRows(result: unknown): number {
  const value = result as
    | { readonly changes?: unknown; readonly count?: unknown }
    | null
    | undefined
  const count = value?.changes ?? value?.count
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export type RawColumnCodec = CodecName | Pick<ColumnDefinition, 'codec' | 'nullable'>
export type RawRowCodecs<R extends object> = { readonly [P in keyof R]?: RawColumnCodec }

/** Decode by the declared semantic codec, never by a field name or provider name. */
export function decodeRawValue(codec: RawColumnCodec, value: unknown, field: string): unknown {
  if (value === null || value === undefined) {
    if (typeof codec === 'object' && !codec.nullable)
      throw new Error(`Non-null raw field ${field} is missing`)
    return value
  }
  const name = typeof codec === 'string' ? codec : codec.codec
  switch (name) {
    case 'bool':
      if (value === true || value === 1) return true
      if (value === false || value === 0) return false
      break
    case 'int':
    case 'epochMs':
    case 'durationMs':
    case 'seq':
    case 'identity': {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^-?\d+$/.test(value)
            ? Number(value)
            : NaN
      if (Number.isSafeInteger(number)) return number
      break
    }
    case 'real': {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : NaN
      if (Number.isFinite(number)) return number
      break
    }
    case 'bigint':
      if (typeof value === 'bigint') return value
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
      if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
      break
    case 'bytes':
      if (value instanceof Uint8Array) return Buffer.from(value)
      break
    case 'jsonDoc':
      return typeof value === 'string' ? JSON.parse(value) : value
    case 'id':
    case 'text':
    case 'enum':
    case 'jsonText':
    case 'rawJson':
    case 'slotKey':
      if (typeof value === 'string') return value
      break
  }
  throw new Error(`Invalid ${name} raw field ${field}`)
}

interface NativeRawDatabase {
  all?: (query: SQLWrapper | string) => unknown
  run?: (query: SQLWrapper | string) => unknown
  execute?: (query: SQLWrapper | string) => PromiseLike<unknown>
}
function nativeRaw(db: PersistenceDb): NativeRawDatabase {
  return db as PersistenceDb & NativeRawDatabase
}

type RawQuery = SQL | SQLWrapper | string
type SyncDatabase = DbClient | DbTxSync

function decodeRows<R extends object>(result: unknown, codecs: RawRowCodecs<R>): R[] {
  if (!Array.isArray(result)) throw new Error('Native raw query did not return rows')
  return result.map((row: Record<string, unknown>) => {
    const decoded: Record<string, unknown> = { ...row }
    for (const [field, codec] of Object.entries(codecs) as [string, RawColumnCodec][])
      decoded[field] = decodeRawValue(codec, row[field], field)
    return decoded as R
  })
}

export function rawRows<R extends object = Record<string, unknown>>(
  db: SyncDatabase,
  query: RawQuery,
  codecs?: RawRowCodecs<R>,
): R[]
export function rawRows<R extends object = Record<string, unknown>>(
  db: PersistenceDb,
  query: RawQuery,
  codecs?: RawRowCodecs<R>,
): R[] | Promise<R[]>
export function rawRows<R extends object = Record<string, unknown>>(
  db: PersistenceDb,
  query: RawQuery,
  codecs: RawRowCodecs<R> = {},
): R[] | Promise<R[]> {
  const native = nativeRaw(db)
  const result = native.execute ? native.execute(query) : native.all!(query)
  if (result && typeof result === 'object' && 'then' in result)
    return Promise.resolve(result).then((rows) => decodeRows(rows, codecs))
  return decodeRows(result, codecs)
}

export function rawFirst<R extends object = Record<string, unknown>>(
  db: SyncDatabase,
  query: RawQuery,
  codecs?: RawRowCodecs<R>,
): R | undefined
export function rawFirst<R extends object = Record<string, unknown>>(
  db: PersistenceDb,
  query: RawQuery,
  codecs?: RawRowCodecs<R>,
): R | undefined | Promise<R | undefined>
export function rawFirst<R extends object = Record<string, unknown>>(
  db: PersistenceDb,
  query: RawQuery,
  codecs: RawRowCodecs<R> = {},
): R | undefined | Promise<R | undefined> {
  const rows = rawRows<R>(db, query, codecs)
  return Array.isArray(rows) ? rows[0] : rows.then((result) => result[0])
}

export function rawExec(db: SyncDatabase, query: RawQuery): ReturnType<DbClient['run']>
export function rawExec(
  db: PersistenceDb,
  query: RawQuery,
): PersistenceWriteResult | Promise<PersistenceWriteResult>
export function rawExec(db: PersistenceDb, query: RawQuery): unknown {
  const native = nativeRaw(db)
  return native.execute ? Promise.resolve(native.execute(query)) : native.run!(query)
}
