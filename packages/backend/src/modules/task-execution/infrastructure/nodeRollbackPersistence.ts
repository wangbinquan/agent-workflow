import { DrizzleTaskRollbackQueries } from './taskRollbackQueries'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { DrizzleTaskExecutionEffectPersistence } from './taskExecutionEffectPersistence'

export type NodeRollbackDatabase = PersistenceDb

export async function loadNodeRollbackTarget(db: PersistenceDb, taskId: string) {
  const target = await new DrizzleTaskRollbackQueries(db).load(taskId)
  return target === null
    ? null
    : {
        taskId: target.taskId,
        db,
        worktreePath: target.worktreePath,
        repos: target.repositories.map((repo) => ({ ...repo })),
      }
}

export function createNodeRollbackEffectObserver(input: {
  readonly db: PersistenceDb
  readonly taskId: string
  readonly nodeRunId: string
  readonly request: unknown
  readonly resourceKeys: readonly string[]
}) {
  return createLocalEffectAttemptObserver({
    persistence: new DrizzleTaskExecutionEffectPersistence(input.db),
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    kind: 'workspace-rollback',
    stableActionOrdinal: 'workspace-rollback',
    candidateId: 'node-snapshot-rollback',
    request: input.request,
    resourceKeys: input.resourceKeys,
  })
}
