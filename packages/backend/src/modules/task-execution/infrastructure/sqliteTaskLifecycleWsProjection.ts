import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import type {
  TaskLifecycleCreatedProjection,
  TaskLifecycleWsProjection,
} from '../application/ports/taskLifecycleWsProjection'
import { createTaskLifecycleWsProjector } from './taskLifecycleWsProjector'

export function createSqliteTaskLifecycleWsProjection(db: DbClient): TaskLifecycleWsProjection {
  return Object.freeze({
    async findCreatedTask(taskId: string): Promise<TaskLifecycleCreatedProjection | null> {
      const row = db
        .select({ task: tasks, workflowName: workflows.name })
        .from(tasks)
        .leftJoin(workflows, eq(workflows.id, tasks.workflowId))
        .where(eq(tasks.id, taskId))
        .get()
      if (row === undefined) return null
      return Object.freeze({
        id: row.task.id,
        name: row.task.name,
        workflowId: row.task.workflowId,
        workflowName: row.workflowName,
        repoPath: row.task.repoPath,
        repoUrl: row.task.repoUrl,
        cachedRepoId: row.task.cachedRepoId,
        status: row.task.status,
        startedAt: row.task.startedAt,
        finishedAt: row.task.finishedAt,
        errorSummary: row.task.errorSummary,
        repoCount: row.task.repoCount,
        spaceKind: row.task.spaceKind,
        sourceAgentName: row.task.sourceAgentName,
      })
    },
  })
}

export function createSqliteTaskLifecycleWsProjector(db: DbClient) {
  return createTaskLifecycleWsProjector(createSqliteTaskLifecycleWsProjection(db))
}
