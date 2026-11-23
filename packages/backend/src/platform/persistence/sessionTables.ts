// RFC-395 I-b: table identity is attached to the native database/transaction, never to process state.
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from './postgresqlDatabaseClient'
import type { DbTxSync } from '@/db/txSync'
import type { NativeTableSets, PersistenceTables, RuntimeSchemaBinding } from './schema/tables'
import type { EngineCapabilities } from './capabilities'
import type { AfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createFileSnapshotTracker, type FileSnapshotTracker } from './fileSnapshots'

export type { PersistenceTables } from './schema/tables'
/** RFC-537: the after-commit event pump the owning session attached to this database (shared by its transactions). */
export interface AfterCommitEventPumpSlot {
  pump: AfterCommitEventPump | null
}
interface DatabaseHandleContext {
  readonly identity: object
  readonly tables: PersistenceTables
  readonly engine: EngineCapabilities
  readonly afterCommit: AfterCommitEventPumpSlot
  /** RFC-539: whole-file snapshots in flight on this database (its WAL checkpoint skips while one is). */
  readonly fileSnapshots: FileSnapshotTracker
  /** RFC-545: the live schema the provider bound this handle with (null for epoch-1 and fixture handles). */
  readonly live: RuntimeSchemaBinding | null
  /** RFC-548: module-owned per-database state by key (see `databaseStateOf`). */
  readonly states: Map<DatabaseStateKey<unknown>, unknown>
}
const contextKey = Symbol('native-persistence-session')
const contexts = new WeakMap<object, DatabaseHandleContext>()

/** Provider construction binds metadata; the handle itself remains the native Drizzle object. */
export function bindDatabaseHandle<T extends object>(
  handle: T,
  tables: PersistenceTables,
  engine: EngineCapabilities,
  live: RuntimeSchemaBinding | null = null,
): T {
  const context = Object.freeze({
    identity: handle,
    tables,
    engine,
    live,
    afterCommit: { pump: null },
    fileSnapshots: createFileSnapshotTracker(),
    states: new Map(),
  })
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
  if (
    context.live === null ||
    context.tables !== context.live.nativeTables[context.engine.provider]
  )
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
/** RFC-537: the handle's after-commit pump slot, or undefined for an object no provider constructed. */
export function afterCommitEventPumpSlotOf(handle: object): AfterCommitEventPumpSlot | undefined {
  return boundContext(handle)?.afterCommit
}
/** RFC-539: the handle's file snapshot tracker (its transactions and native session share it). */
export function fileSnapshotTrackerOf(handle: object): FileSnapshotTracker {
  const tracker = boundContext(handle)?.fileSnapshots
  if (tracker === undefined) throw new Error('file-snapshot-handle-unbound')
  return tracker
}
/**
 * RFC-548: the key a module keeps its own per-database in-process state under. The module holds the key (left
 * unexported, no one else reaches the state); the state is created on first use and shared by the database's client,
 * transactions and native session, like the after-commit pump slot and the file snapshot tracker.
 */
export interface DatabaseStateKey<T> {
  readonly create: () => T
}
export function databaseStateKey<T>(create: () => T): DatabaseStateKey<T> {
  return Object.freeze({ create })
}
/** The database's state under `key`, created on first use; an object no provider constructed has none. */
export function databaseStateOf<T>(handle: object, key: DatabaseStateKey<T>): T {
  const states = databaseHandleContext(handle).states
  if (!states.has(key)) states.set(key, key.create())
  return states.get(key) as T
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
