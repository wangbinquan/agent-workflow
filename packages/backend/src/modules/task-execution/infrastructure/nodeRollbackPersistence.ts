import { asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskRepos, tasks } from '@/db/schema'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { DrizzleTaskExecutionEffectPersistence } from './taskExecutionEffectPersistence'

export type NodeRollbackDatabase = ProviderNeutralDatabase

export async function loadNodeRollbackTarget(db: ProviderNeutralDatabase, taskId: string) {
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (task === undefined) return null
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos =
    repoRows.length > 0
      ? repoRows.map((row) => ({
          worktreePath: row.worktreePath,
          worktreeDirName: row.worktreeDirName,
        }))
      : [{ worktreePath: task.worktreePath, worktreeDirName: '' }]
  return {
    taskId,
    db,
    repoCount: task.repoCount,
    worktreePath: task.worktreePath,
    repos,
  }
}

export function createNodeRollbackEffectObserver(input: {
  readonly db: ProviderNeutralDatabase
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
