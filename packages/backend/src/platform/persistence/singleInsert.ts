// RFC-395 I-b: native single-row writes may fold the generation check into their SQL AST.
import type { InferInsertModel, Placeholder, SQL, Table } from 'drizzle-orm'
import type { PersistenceDb, PersistenceWriteResult } from './querySurface'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { queryWrite } from './queryHelpers'

export type PersistenceInsertValues<T extends Table> = {
  [P in keyof InferInsertModel<T>]: InferInsertModel<T>[P] | SQL | Placeholder
}
type WriteResult = PersistenceWriteResult | Promise<PersistenceWriteResult>
type SingleInsert = (
  table: Table,
  value: Record<string, unknown>,
  fallback: () => WriteResult,
) => WriteResult
/** RFC-542: the fenced single-row insert rides on the root database object itself (not in a module registry) and
 * answers only for that very object, as an identity-keyed table did. Derived handles (transactions) and wrappers around
 * the root (a proxy forwards property reads to it) are other objects and keep the ordinary insert. */
interface SingleInsertSlot {
  readonly owner: object
  readonly insert: SingleInsert
}
const singleInsertKey = Symbol('persistence-single-insert')
export function bindSingleInsert(db: object, insert: SingleInsert): void {
  const slot: SingleInsertSlot = Object.freeze({ owner: db, insert })
  Object.defineProperty(db, singleInsertKey, { value: slot, configurable: true })
}
function singleInsertOf(db: object): SingleInsert | undefined {
  const slot = (db as { [singleInsertKey]?: SingleInsertSlot })[singleInsertKey]
  return slot?.owner === db ? slot.insert : undefined
}
/** The handle is still the native database. Only this terminal opts in to the fenced INSERT. */
export function insertOne<T extends Table>(
  db: DbClient | DbTxSync,
  table: T,
  value: PersistenceInsertValues<T>,
): PersistenceWriteResult
export function insertOne<T extends Table>(
  db: Pick<PersistenceDb, 'insert'>,
  table: T,
  value: PersistenceInsertValues<T>,
): WriteResult
export function insertOne<T extends Table>(
  db: Pick<PersistenceDb, 'insert'>,
  table: T,
  value: PersistenceInsertValues<T>,
): WriteResult {
  const fallback = () => queryWrite(db.insert(table).values(value))
  return singleInsertOf(db)?.(table, value, fallback) ?? fallback()
}
