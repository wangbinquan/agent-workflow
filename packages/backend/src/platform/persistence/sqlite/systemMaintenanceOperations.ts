import type { DbClient } from '@/db/client'
import { createMaintenanceRunStore } from '@/platform/persistence/sqlite/maintenanceRunStore'
import type { MaintenanceRunStore } from '@/platform/background/maintenanceRunStorePort'
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

/** Async application contract over the RFC-338 synchronous Worker-owned
 * SQLite store. The adapter does not move SQLite work onto the daemon thread;
 * it only normalizes the provider contract inside the maintenance Worker. */
export function createSqliteMaintenanceRunStore(db: DbClient): MaintenanceRunStore {
  const store = createMaintenanceRunStore(db)
  const adapter: MaintenanceRunStore = {
    async enqueue(input) {
      return store.enqueue(input)
    },
    async recoverExpired(now) {
      return store.recoverExpired(now)
    },
    async recoverRunning(now) {
      return store.recoverRunning(now)
    },
    async claimNext(input) {
      return store.claimNext(input)
    },
    async heartbeat(input) {
      return store.heartbeat(input)
    },
    async settle(input) {
      return store.settle(input)
    },
    async read(runId) {
      return store.read(runId)
    },
    async hasCycle(cycleKey) {
      return store.hasCycle(cycleKey)
    },
    async readProjection() {
      return store.readProjection()
    },
  }
  return Object.freeze(adapter)
}
