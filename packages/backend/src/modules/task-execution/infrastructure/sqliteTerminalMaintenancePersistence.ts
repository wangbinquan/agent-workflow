import type { DbClient } from '@/db/client'
import type { TerminalMaintenanceStore } from '../application/ports/terminalMaintenanceStore'
import { SqliteTerminalMaintenanceStore } from './sqliteTerminalMaintenance'

export class SqliteTerminalMaintenancePersistence implements TerminalMaintenanceStore {
  private readonly store = new SqliteTerminalMaintenanceStore()

  constructor(private readonly db: DbClient) {}

  async snapshotMembers(taskIds: readonly string[]) {
    return this.store.snapshotMembers(this.db, taskIds)
  }

  async snapshotTree(rootTaskId: string) {
    return this.store.snapshotTree(this.db, rootTaskId)
  }

  async claim(input: Parameters<TerminalMaintenanceStore['claim']>[0]) {
    return this.store.claim({ db: this.db, ...input })
  }

  async transition(input: Parameters<TerminalMaintenanceStore['transition']>[0]) {
    return this.store.transition({ db: this.db, ...input })
  }

  async complete(input: Parameters<TerminalMaintenanceStore['complete']>[0]): Promise<void> {
    this.store.complete({ db: this.db, ...input })
  }

  async listRecoverable(input: Parameters<TerminalMaintenanceStore['listRecoverable']>[0]) {
    return this.store.listRecoverable({ db: this.db, ...input })
  }
}
