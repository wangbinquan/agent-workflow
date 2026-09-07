// RFC-359 W7：持久化实现只有一份（`infrastructure/resourceLimitPersistence.ts`），
// 两个 provider 的具名装配函数在这里只做绑定 —— 差的仅是客户端来源与 cancelTask 的取法。
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceLimitOperations } from '../application/ports/resourceLimitPersistence'
import { DrizzleResourceLimitPersistence } from '../infrastructure/resourceLimitPersistence'

/** Compatibility composition for SQLite callers not yet assembled at bootstrap. */
export function composeLegacySqliteResourceLimitOperations(db: DbClient): ResourceLimitOperations {
  return Object.freeze({
    persistence: new DrizzleResourceLimitPersistence(db),
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
    persistence: new DrizzleResourceLimitPersistence(input.db),
    cancelTask: input.cancelTask,
  })
}
