// RFC-345 T4a — bootstrap binding for task-execution resource snapshots.

import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import { createTaskExecutionResourceSnapshotInTx } from '../application/participants/taskExecutionResourceSnapshot'
import {
  createLegacyTaskExecutionResourceSnapshotPorts,
  type LegacyTaskExecutionResourceDependencies,
} from '../infrastructure/aggregateAdapters/legacyTaskExecutionResourceSnapshots'
import {
  createPostgresqlTaskExecutionResourceSnapshotReader,
  type PostgresqlTaskExecutionResourceDependencies,
  type PostgresqlTaskExecutionResourceSnapshotReader,
  type PostgresqlTaskExecutionResourceTransaction,
} from '../infrastructure/aggregateAdapters/postgresqlTaskExecutionResourceSnapshots'
import type {
  ResourceRequestContext,
  TaskExecutionResourceSnapshotInTx,
} from '../public/participants'

interface TaskExecutionResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

interface TaskExecutionResourceBinding {
  inTransaction(
    tx: DbTxSync,
    pair: TaskExecutionResourceAuthorityPair,
  ): TaskExecutionResourceSnapshotInTx
}

export interface PostgresqlTaskExecutionResourceSnapshotFactory {
  inTransaction(
    transaction: PostgresqlTaskExecutionResourceTransaction,
    pair: TaskExecutionResourceAuthorityPair,
  ): PostgresqlTaskExecutionResourceSnapshotReader
}

export function composeTaskExecutionResourceBinding(
  dependencies: LegacyTaskExecutionResourceDependencies,
): TaskExecutionResourceBinding {
  return Object.freeze({
    inTransaction(tx: DbTxSync, pair: TaskExecutionResourceAuthorityPair) {
      return createTaskExecutionResourceSnapshotInTx(
        createLegacyTaskExecutionResourceSnapshotPorts(
          { tx, authority: pair.authority, actor: pair.actor },
          dependencies,
        ),
      )
    },
  })
}

/**
 * PostgreSQL Task Execution adapter factory. The Task Execution owner opens a
 * repeatable-read transaction; Resource Catalog binds every recursive closure
 * lookup to that exact transaction and exact admitted authority pair.
 */
export function composePostgresqlTaskExecutionResourceSnapshotFactory(
  dependencies: PostgresqlTaskExecutionResourceDependencies,
): PostgresqlTaskExecutionResourceSnapshotFactory {
  return Object.freeze({
    inTransaction(
      transaction: PostgresqlTaskExecutionResourceTransaction,
      pair: TaskExecutionResourceAuthorityPair,
    ) {
      return createPostgresqlTaskExecutionResourceSnapshotReader(
        { transaction, authority: pair.authority, actor: pair.actor },
        dependencies,
      )
    },
  })
}
