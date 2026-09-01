import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { TaskExecutionResourceSnapshotInTx } from '@/modules/resource-catalog/public/participants'
import type { TaskExecutionResourceBinding } from '../application/ports/taskExecutionResourceSnapshots'
import { freezeTaskExecutionCallClosureSync } from '../application/taskExecutionCallClosure'

type AuthorityPair = Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0]

/** Existing Resource Catalog transaction participant, isolated in the SQLite adapter. */
export interface SqliteTaskExecutionResourceSnapshotFactory {
  inTransaction(tx: DbTxSync, pair: AuthorityPair): TaskExecutionResourceSnapshotInTx
}

export function createSqliteTaskExecutionResourceBinding(
  db: DbClient,
  factory: SqliteTaskExecutionResourceSnapshotFactory,
): TaskExecutionResourceBinding {
  return Object.freeze({
    async loadAuthorized(
      pair: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0],
      requests: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[1],
    ) {
      return dbTxSync(db, (tx) => {
        const participant = factory.inTransaction(tx, pair)
        return participant.loadAuthorized(pair.authority, requests)
      })
    },
    async freezeCallClosure(
      pair: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[0],
      root: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[1],
    ) {
      return dbTxSync(db, (tx) => {
        const participant = factory.inTransaction(tx, pair)
        return freezeTaskExecutionCallClosureSync(root, (requests) =>
          participant.loadAuthorized(pair.authority, requests),
        )
      })
    },
  })
}
