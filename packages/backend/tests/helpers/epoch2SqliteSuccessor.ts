import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
import { createRestoreSuccessor } from './rfc395V3/successor'
import type { Database } from 'bun:sqlite'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { applyHistoryVersion } from '@/platform/persistence/schema/history/apply'

export async function appendSqliteSuccessor(database: Database) {
  const version = createRestoreSuccessor(
    persistenceHead(),
    'rfc213_successor_probe',
    'restore-successor',
  )
  await applyHistoryVersion(sqliteHistorySession(database), {
    version,
    metaTables: EPOCH2_META_TABLES,
  })
  database
    .query("UPDATE aw_meta_generations SET contract_digest=?,plan_digest=? WHERE state='active'")
    .run(version.contract.contract.digest, version.sqlite.digest)
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return version
}
