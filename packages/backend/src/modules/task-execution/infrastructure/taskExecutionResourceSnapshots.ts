// RFC-359 W4-D27 —— 任务执行资源快照的绑定：一份实现，两个引擎共用。
//
// 合一前 `sqliteTaskExecutionResourceSnapshots.ts` 用 `dbTxSync`（BEGIN IMMEDIATE）+ 同步闭包冻结，
// `postgresqlTaskExecutionResourceSnapshots.ts` 用 `REPEATABLE READ READ ONLY` + 异步闭包冻结。
// 两处差异都收进中立原语，且**两个引擎各自的边界一格未改**：
//   * `DatabaseSession.snapshotRead` —— SQLite 仍是 BEGIN IMMEDIATE（`dbTxSync` 本来就是它），
//     PG 仍是 REPEATABLE READ READ ONLY；闭包递归取数照旧全绑在同一笔上。
//   * `freezeTaskExecutionCallClosureAsync` —— 与同步版逐语句同构（同一个 builder、同一顺序、
//     同一序列化），只在 loader 上多一个 await，所以异步版严格覆盖同步版。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskExecutionResourceSnapshotInTx } from '@/modules/resource-catalog/public/participants'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { TaskExecutionResourceBinding } from '../application/ports/taskExecutionResourceSnapshots'
import { freezeTaskExecutionCallClosureAsync } from '../application/taskExecutionCallClosure'

type AuthorityPair = Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0]

/** Resource Catalog 提供的事务内快照参与者；task-execution 只拿到这一个绑定面。 */
export interface TaskExecutionResourceSnapshotFactory {
  inTransaction(tx: DatabaseTransaction, pair: AuthorityPair): TaskExecutionResourceSnapshotInTx
}

export function createTaskExecutionResourceBinding(
  db: ProviderNeutralDatabase,
  factory: TaskExecutionResourceSnapshotFactory,
): TaskExecutionResourceBinding {
  const session = databaseSessionFor(db)
  return Object.freeze({
    async loadAuthorized(
      pair: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0],
      requests: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[1],
    ) {
      return await session.snapshotRead(async (tx) => {
        const participant = factory.inTransaction(tx, pair)
        return await participant.loadAuthorized(pair.authority, requests)
      })
    },
    async freezeCallClosure(
      pair: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[0],
      root: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[1],
    ) {
      return await session.snapshotRead(async (tx) => {
        const participant = factory.inTransaction(tx, pair)
        return await freezeTaskExecutionCallClosureAsync(
          root,
          async (requests) => await participant.loadAuthorized(pair.authority, requests),
        )
      })
    },
  })
}
