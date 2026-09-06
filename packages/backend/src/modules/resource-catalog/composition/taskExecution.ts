// RFC-345 T4a — bootstrap binding for task-execution resource snapshots.

import type { Actor } from '@/auth/actor'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createTaskExecutionResourceSnapshotInTx } from '../application/participants/taskExecutionResourceSnapshot'
import {
  createTaskExecutionResourceSnapshotPorts,
  type TaskExecutionResourceDependencies,
} from '../infrastructure/aggregateAdapters/taskExecutionResourceSnapshots'
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
    tx: DatabaseTransaction,
    pair: TaskExecutionResourceAuthorityPair,
  ): TaskExecutionResourceSnapshotInTx
}

export function composeTaskExecutionResourceBinding(
  dependencies: TaskExecutionResourceDependencies,
): TaskExecutionResourceBinding {
  return Object.freeze({
    inTransaction(tx: DatabaseTransaction, pair: TaskExecutionResourceAuthorityPair) {
      return createTaskExecutionResourceSnapshotInTx(
        createTaskExecutionResourceSnapshotPorts(
          { tx, authority: pair.authority, actor: pair.actor },
          dependencies,
        ),
      )
    },
  })
}
