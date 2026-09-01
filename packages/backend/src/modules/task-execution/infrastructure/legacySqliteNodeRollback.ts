import { asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskRepos, tasks } from '@/db/schema'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { SqliteTaskExecutionEffectPersistence } from './sqliteTaskExecutionEffectPersistence'

export type LegacySqliteRollbackDatabase = DbClient

export async function loadLegacySqliteRollbackTarget(db: DbClient, taskId: string) {
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

export function createLegacySqliteRollbackEffectObserver(input: {
  readonly db: DbClient
  readonly taskId: string
  readonly nodeRunId: string
  readonly request: unknown
  readonly resourceKeys: readonly string[]
}) {
  return createLocalEffectAttemptObserver({
    persistence: new SqliteTaskExecutionEffectPersistence(input.db),
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    kind: 'workspace-rollback',
    stableActionOrdinal: 'workspace-rollback',
    candidateId: 'node-snapshot-rollback',
    request: input.request,
    resourceKeys: input.resourceKeys,
  })
}
