// RFC-395 I-b: table identity is attached to the native database/transaction, never to process state.
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'
import type { DbTxSync } from '@/db/txSync'
import {
  persistenceSchemaBinding,
  type NativeTableSets,
  type PersistenceTables,
} from './schema/tables'
import type { EngineCapabilities } from './capabilities'

export type { PersistenceTables } from './schema/tables'
interface DatabaseHandleContext {
  readonly identity: object
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
  const context = Object.freeze({ identity: handle, tables, engine })
  contexts.set(handle, context)
  if (Object.isExtensible(handle))
    Object.defineProperty(handle, contextKey, { value: context, configurable: true })
  // Native Drizzle transactions create a new session around the same provider client.
  const client = (handle as { session?: { client?: object } }).session?.client
  if (client) {
    contexts.set(client, context)
    if (Object.isExtensible(client))
      Object.defineProperty(client, contextKey, { value: context, configurable: true })
  }
  return handle
}

/** The full schema is available for now; module-scoped subsets belong to RFC-395 T11. */
export function tablesOf(handle: DbClient | DbTxSync): NativeTableSets['sqlite']
export function tablesOf(handle: PostgresqlDatabaseClient): NativeTableSets['postgresql']
export function tablesOf(handle: object): PersistenceTables
export function tablesOf(handle: object): PersistenceTables {
  const context = databaseHandleContext(handle)
  if (context.tables !== persistenceSchemaBinding().nativeTables[context.engine.provider])
    throw new Error('Native persistence handle has no epoch-2 table set')
  return context.tables
}
export function engineForHandle(handle: object): EngineCapabilities {
  return databaseHandleContext(handle).engine
}
/** The engine bound to a native handle, or undefined for an object no provider constructed. */
export function boundEngineOf(handle: object): EngineCapabilities | undefined {
  return boundContext(handle)?.engine
}
export function inheritDatabaseHandle<T extends object>(handle: T, parent: object): T {
  const context = databaseHandleContext(parent)
  contexts.set(handle, context)
  if (Object.isExtensible(handle))
    Object.defineProperty(handle, contextKey, { value: context, configurable: true })
  return handle
}
function boundContext(handle: object): DatabaseHandleContext | undefined {
  const native = handle as {
    [contextKey]?: DatabaseHandleContext
    session?: { client?: { [contextKey]?: DatabaseHandleContext } }
  }
  const client = native.session?.client
  return (
    contexts.get(handle) ??
    native[contextKey] ??
    (client && (contexts.get(client) ?? client[contextKey]))
  )
}
export function databaseHandleContext(handle: object): DatabaseHandleContext {
  const context = boundContext(handle)
  if (!context) throw new Error('Native persistence handle has no session table set')
  return context
}
