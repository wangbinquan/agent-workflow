import { sql } from 'drizzle-orm'

import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
} from '@/modules/resource-catalog/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionResourceBinding } from '../application/ports/taskExecutionResourceSnapshots'
import { freezeTaskExecutionCallClosureAsync } from '../application/taskExecutionCallClosure'

export type PostgresqlTaskExecutionResourceTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

type AuthorityPair = Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0]

/** Provider-owned reader bound to the reserved PostgreSQL transaction. */
export interface PostgresqlTaskExecutionResourceSnapshotInTransaction {
  loadAuthorized(
    authority: ResourceRequestContext,
    requests: readonly TaskExecutionResourceRequest[],
  ): Promise<readonly FrozenTaskExecutionResourceSnapshot[]>
}

export interface PostgresqlTaskExecutionResourceSnapshotFactory {
  inTransaction(
    transaction: PostgresqlTaskExecutionResourceTransaction,
    pair: AuthorityPair,
  ): PostgresqlTaskExecutionResourceSnapshotInTransaction
}

async function inSnapshotTransaction<T>(
  db: PostgresqlDatabaseClient,
  body: (transaction: PostgresqlTaskExecutionResourceTransaction) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (transaction) => {
    await transaction.run(sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
    return await body(transaction)
  })
}

export function createPostgresqlTaskExecutionResourceBinding(
  db: PostgresqlDatabaseClient,
  factory: PostgresqlTaskExecutionResourceSnapshotFactory,
): TaskExecutionResourceBinding {
  return Object.freeze({
    async loadAuthorized(
      pair: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[0],
      requests: Parameters<TaskExecutionResourceBinding['loadAuthorized']>[1],
    ) {
      return await inSnapshotTransaction(db, async (transaction) => {
        const participant = factory.inTransaction(transaction, pair)
        return await participant.loadAuthorized(pair.authority, requests)
      })
    },
    async freezeCallClosure(
      pair: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[0],
      root: Parameters<TaskExecutionResourceBinding['freezeCallClosure']>[1],
    ) {
      return await inSnapshotTransaction(db, async (transaction) => {
        const participant = factory.inTransaction(transaction, pair)
        return await freezeTaskExecutionCallClosureAsync(root, (requests) =>
          participant.loadAuthorized(pair.authority, requests),
        )
      })
    },
  })
}
