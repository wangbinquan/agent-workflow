// Bind the native baseline mechanism to this binary's embedded schema and metadata roster.
import type { Database } from 'bun:sqlite'
import { persistenceHead } from './persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import {
  createSqliteBaseline as createNativeBaseline,
  installSqliteBaseline as installNativeBaseline,
  type SqliteBaselineOptions,
} from '@/platform/persistence/sqlite/baseline'
export type { SqliteBaselineOptions } from '@/platform/persistence/sqlite/baseline'
const definition = () => ({ head: persistenceHead(), metaTables: EPOCH2_META_TABLES })
export function createSqliteBaseline(options: SqliteBaselineOptions = {}): Database {
  return createNativeBaseline(definition(), options)
}
export function installSqliteBaseline(
  database: Database,
  options: SqliteBaselineOptions = {},
): void {
  installNativeBaseline(definition(), database, options)
}
