// RFC-395 I-b: table identity is attached to the native database/transaction, never to process state.
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'
import type { DbTxSync } from '@/db/txSync'
import type { nativeTableSets, persistenceSchema } from '@/db/schema'
import type { NeutralTableSet } from './schema/neutral'
import type { EngineCapabilities } from './capabilities'

export type PersistenceTables = NeutralTableSet<typeof persistenceSchema.tables>
interface DatabaseHandleContext {
  readonly tables: PersistenceTables
  readonly engine: EngineCapabilities
}
const contextKey = Symbol('native-persistence-session')
const contexts = new WeakMap<object, DatabaseHandleContext>()

/** Provider construction binds metadata; the handle itself remains the native Drizzle object. */
export function bindDatabaseHandle<T extends object>(
  handle: T,
  tables: PersistenceTables,
  engine: EngineCapabilities,
): T {
  const context = Object.freeze({ tables, engine })
  contexts.set(handle, context)
  Object.defineProperty(handle, contextKey, { value: context, configurable: true })
  return handle
}

/** The full schema is available for now; module-scoped subsets belong to RFC-395 T11. */
export function tablesOf(handle: DbClient | DbTxSync): typeof nativeTableSets.sqlite
export function tablesOf(handle: PostgresqlDatabaseClient): typeof nativeTableSets.postgresql
export function tablesOf(handle: object): PersistenceTables
export function tablesOf(handle: object): PersistenceTables {
  return databaseHandleContext(handle).tables
}
export function engineForHandle(handle: object): EngineCapabilities {
  return databaseHandleContext(handle).engine
}
export function inheritDatabaseHandle<T extends object>(handle: T, parent: object): T {
  const context = databaseHandleContext(parent)
  contexts.set(handle, context)
  Object.defineProperty(handle, contextKey, { value: context, configurable: true })
  return handle
}
function databaseHandleContext(handle: object): DatabaseHandleContext {
  const native = handle as {
    [contextKey]?: DatabaseHandleContext
    session?: { client?: { [contextKey]?: DatabaseHandleContext } }
  }
  const context = contexts.get(handle) ?? native[contextKey] ?? native.session?.client?.[contextKey]
  if (!context) throw new Error('Native persistence handle has no session table set')
  return context
}
