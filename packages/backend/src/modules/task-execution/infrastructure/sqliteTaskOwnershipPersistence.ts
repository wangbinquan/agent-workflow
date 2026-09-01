import type { DbClient } from '@/db/client'
import type { TaskOwnershipPersistence } from '../application/ports/taskOwnershipPersistence'
import { SqliteTaskOwnershipStore } from './sqliteTaskOwnership'

export class SqliteTaskOwnershipPersistence implements TaskOwnershipPersistence {
  private readonly store = new SqliteTaskOwnershipStore()

  constructor(private readonly db: DbClient) {}

  async claimPendingIntent(input: Parameters<TaskOwnershipPersistence['claimPendingIntent']>[0]) {
    return this.store.claimPendingIntent({ db: this.db, ...input })
  }

  async heartbeat(input: Parameters<TaskOwnershipPersistence['heartbeat']>[0]) {
    return this.store.heartbeat({ db: this.db, ...input })
  }

  async revokeExact(input: Parameters<TaskOwnershipPersistence['revokeExact']>[0]) {
    return this.store.revokeExact({ db: this.db, ...input })
  }

  async revokeOldDaemon(input: Parameters<TaskOwnershipPersistence['revokeOldDaemon']>[0]) {
    return this.store.revokeOldDaemon({ db: this.db, ...input })
  }

  async markRecoveryRequired(
    input: Parameters<TaskOwnershipPersistence['markRecoveryRequired']>[0],
  ) {
    return this.store.markRecoveryRequired({ db: this.db, ...input })
  }

  async releaseAfterStop(input: Parameters<TaskOwnershipPersistence['releaseAfterStop']>[0]) {
    return this.store.releaseAfterStop({ db: this.db, ...input })
  }

  async releaseRecovered(input: Parameters<TaskOwnershipPersistence['releaseRecovered']>[0]) {
    return this.store.releaseRecovered({ db: this.db, ...input })
  }

  async read(taskId: string) {
    return this.store.read(this.db, taskId)
  }
}
