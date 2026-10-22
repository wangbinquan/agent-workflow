// RFC-359 W4-B1 —— 任务生命周期 WS 投影：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type {
  TaskLifecycleCreatedProjection,
  TaskLifecycleWsProjection,
} from '../application/ports/taskLifecycleWsProjection'
import { createTaskLifecycleWsProjector } from './taskLifecycleWsProjector'

export function createDatabaseTaskLifecycleWsProjection(
  db: PersistenceDb,
): TaskLifecycleWsProjection {
  return Object.freeze({
    async findCreatedTask(taskId: string): Promise<TaskLifecycleCreatedProjection | null> {
      const { tasks, workflows } = tablesOf(db)
      const rows = await db
        .select({ task: tasks, workflowName: workflows.name })
        .from(tasks)
        .leftJoin(workflows, eq(workflows.id, tasks.workflowId))
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
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

export function createDatabaseTaskLifecycleWsProjector(db: PersistenceDb) {
  return createTaskLifecycleWsProjector(createDatabaseTaskLifecycleWsProjection(db))
}
