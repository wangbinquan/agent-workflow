import type { DbClient } from '@/db/client'
import { isDbSnapshotInProgress } from '@/platform/persistence/sqlite/systemProviderBackup'

export type SqliteMaintenanceDatabase = DbClient

/** SQLite physical checkpoint. Kept in infrastructure so the scheduler and
 * worker dispatch a capability instead of importing DbClient/PRAGMA. */
export function checkpointSqliteWal(db: DbClient): void {
  db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE);')
}

export function runSqliteWalCheckpointTick(db: DbClient): 'checkpointed' | 'skipped-snapshot' {
  if (isDbSnapshotInProgress()) return 'skipped-snapshot'
  checkpointSqliteWal(db)
  return 'checkpointed'
}
