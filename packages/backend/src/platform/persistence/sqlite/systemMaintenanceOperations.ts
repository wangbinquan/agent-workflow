import type { DbClient } from '@/db/client'
import type { FileSnapshotTracker } from '@/platform/persistence/fileSnapshots'

export type SqliteMaintenanceDatabase = DbClient

/** SQLite physical checkpoint. Kept in infrastructure so the scheduler and
 * worker dispatch a capability instead of importing DbClient/PRAGMA. */
export function checkpointSqliteWal(db: DbClient): void {
  db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE);')
}

/** RFC-539: skips while a whole-file snapshot of this database is in flight (the tracker its snapshot takers count on). */
export function runSqliteWalCheckpointTick(
  db: DbClient,
  snapshots: FileSnapshotTracker,
): 'checkpointed' | 'skipped-snapshot' {
  if (snapshots.inFlight()) return 'skipped-snapshot'
  checkpointSqliteWal(db)
  return 'checkpointed'
}
