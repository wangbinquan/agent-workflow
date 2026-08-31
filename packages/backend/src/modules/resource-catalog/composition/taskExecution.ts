// RFC-345 T4a — bootstrap binding for task-execution resource snapshots.

import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import { createTaskExecutionResourceSnapshotInTx } from '../application/participants/taskExecutionResourceSnapshot'
import {
  createLegacyTaskExecutionResourceSnapshotPorts,
  type LegacyTaskExecutionResourceDependencies,
} from '../infrastructure/aggregateAdapters/legacyTaskExecutionResourceSnapshots'
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
