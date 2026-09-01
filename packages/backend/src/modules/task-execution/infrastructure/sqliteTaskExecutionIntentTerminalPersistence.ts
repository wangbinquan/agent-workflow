// RFC-349 — Promise adapter for SQLite intent terminalization.

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { TaskExecutionIntentTerminalPersistence } from '../application/terminalizeExecutionIntent'
import { terminalizeTaskExecutionIntentsTx } from './sqliteTerminalizeExecutionIntent'

export class SqliteTaskExecutionIntentTerminalPersistence implements TaskExecutionIntentTerminalPersistence {
  constructor(private readonly db: DbClient) {}

  async terminalize(
    input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
  ): Promise<void> {
    dbTxSync(this.db, (tx) => terminalizeTaskExecutionIntentsTx({ tx, ...input }))
  }
}
