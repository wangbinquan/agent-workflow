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
const inserts = new WeakMap<object, SingleInsert>()
export function bindSingleInsert(db: object, insert: SingleInsert): void {
  inserts.set(db, insert)
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
  return inserts.get(db)?.(table, value, fallback) ?? fallback()
}
