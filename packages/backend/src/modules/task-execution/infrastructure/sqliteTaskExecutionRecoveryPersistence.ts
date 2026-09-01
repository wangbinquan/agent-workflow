// RFC-349 — Promise adapter for the proven SQLite successor recovery flow.

import type { DbClient } from '@/db/client'
import type { TaskExecutionRecoveryPersistence } from '../application/recoverTaskExecutions'
import {
  finalizeTaskExecutionRecovery,
  prepareTaskExecutionRecovery,
} from './sqliteTaskExecutionRecovery'

export class SqliteTaskExecutionRecoveryPersistence implements TaskExecutionRecoveryPersistence {
  constructor(private readonly db: DbClient) {}

  async prepare(input: Parameters<TaskExecutionRecoveryPersistence['prepare']>[0]) {
    return prepareTaskExecutionRecovery({ db: this.db, ...input })
  }

  async finalize(input: Parameters<TaskExecutionRecoveryPersistence['finalize']>[0]) {
    return await finalizeTaskExecutionRecovery({ db: this.db, ...input })
  }
}
