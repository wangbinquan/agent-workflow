import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceLimitOperations } from '../application/ports/resourceLimitPersistence'
import { PostgresqlResourceLimitPersistence } from '../infrastructure/postgresqlResourceLimitPersistence'
import { SqliteResourceLimitPersistence } from '../infrastructure/sqliteResourceLimitPersistence'

/** Compatibility composition for SQLite callers not yet assembled at bootstrap. */
export function composeLegacySqliteResourceLimitOperations(db: DbClient): ResourceLimitOperations {
  return Object.freeze({
    persistence: new SqliteResourceLimitPersistence(db),
    cancelTask: async (taskId: string) => {
      // The compatibility bridge is lazy so PostgreSQL composition never loads
      // or captures the SQLite-only legacy Task service.
      const { cancelTask } = await import('@/services/task')
      await cancelTask(db, taskId)
    },
  })
}

export function composePostgresqlResourceLimitOperations(input: {
  readonly db: PostgresqlDatabaseClient
  /** Required Task Execution command; no provider fallback is fabricated here. */
  readonly cancelTask: (taskId: string) => Promise<void>
}): ResourceLimitOperations {
  return Object.freeze({
    persistence: new PostgresqlResourceLimitPersistence(input.db),
    cancelTask: input.cancelTask,
  })
}
