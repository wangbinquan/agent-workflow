// RFC-359 W7：持久化实现只有一份（`infrastructure/resourceLimitPersistence.ts`），
// 两个 provider 的具名装配函数在这里只做绑定 —— 差的仅是客户端来源与 cancelTask 的取法。
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResourceLimitOperations } from '../application/ports/resourceLimitPersistence'
import { DrizzleResourceLimitPersistence } from '../infrastructure/resourceLimitPersistence'

/** Compatibility composition for SQLite callers not yet assembled at bootstrap. */
export function composeLegacySqliteResourceLimitOperations(
  db: ProviderNeutralDatabase,
): ResourceLimitOperations {
  const operations: ResourceLimitOperations = {
    persistence: new DrizzleResourceLimitPersistence(db),
    // RFC-359 AC-1（第 11 刀下半）：取消实现已搬进 task-execution 模块，绑它不再连带
    // 拉进 legacy Task service，于是惰性 import 的理由消失，改成普通静态装配。
    cancelTask: (taskId, reason) =>
      composeTaskCancellation(db).cancel(taskId, { kind: 'resource-reaped', ...reason }),
  }
  return Object.freeze(operations)
}

export function composePostgresqlResourceLimitOperations(input: {
  readonly db: PostgresqlDatabaseClient
  /** Required Task Execution command; no provider fallback is fabricated here. */
  readonly cancelTask: ResourceLimitOperations['cancelTask']
}): ResourceLimitOperations {
  return Object.freeze({
    persistence: new DrizzleResourceLimitPersistence(input.db),
    cancelTask: input.cancelTask,
  })
}
