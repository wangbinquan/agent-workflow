// RFC-350 —— 不活跃超时收割的装配出口（bootstrap 唯一入口）。
//
// `cancelTask` 由调用方注入：SQLite daemon 传既有的 legacy 桥（懒 import
// `services/task.ts`，与 `composeLegacySqliteResourceLimitOperations` 同款），
// PostgreSQL daemon 传它自己的 task-execution cancel 命令。这里**不伪造任何 provider
// 兜底**——RFC-349 的准入纪律。

import { killStaleRunProcessTree } from '@/util/process'

import type {
  IdleTimeoutRunSnapshot,
  TaskIdleTimeoutOperations,
  TaskIdleTimeoutPersistence,
} from '../application/ports/taskIdleTimeoutPersistence'

export {
  MAX_TREES_PER_SWEEP,
  runTaskIdleTimeoutSweep,
  type IdleTimeoutSweepResult,
  type TaskIdleTimeoutConfig,
} from '../application/taskIdleTimeoutReaper'
export { createPostgresqlTaskIdleTimeoutPersistence } from '../infrastructure/postgresqlTaskIdleTimeoutPersistence'
export { createSqliteTaskIdleTimeoutPersistence } from '../infrastructure/sqliteTaskIdleTimeoutPersistence'
export type {
  IdleTimeoutRunSnapshot,
  IdleTimeoutTreeSnapshot,
  TaskIdleTimeoutOperations,
  TaskIdleTimeoutPersistence,
} from '../application/ports/taskIdleTimeoutPersistence'

/**
 * 把 persistence + 注入的 cancelTask 组装成收割器要的 operations。
 * 进程终止固定用 `killStaleRunProcessTree`（PID 复用窗口 + 二进制身份门），
 * 只有测试会替换它。
 */
export function composeTaskIdleTimeoutOperations(input: {
  readonly persistence: TaskIdleTimeoutPersistence
  readonly cancelTask: (taskId: string) => Promise<void>
  readonly killRunProcessTree?: TaskIdleTimeoutOperations['killRunProcessTree']
}): TaskIdleTimeoutOperations {
  return Object.freeze({
    persistence: input.persistence,
    cancelTask: input.cancelTask,
    killRunProcessTree:
      input.killRunProcessTree ??
      ((run: IdleTimeoutRunSnapshot) =>
        killStaleRunProcessTree({
          pid: run.pid,
          startedAt: run.startedAt,
          spawnBinaryPath: run.spawnBinaryPath,
          spawnLaunchNonce: run.spawnLaunchNonce,
        })),
  })
}
