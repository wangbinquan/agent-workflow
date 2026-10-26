import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B1 —— 任务生命周期 WS 投影：一份实现，两个 provider 共用。

import { workflowNameExpression } from '@/modules/resource-catalog/public/queries'
import { eq } from 'drizzle-orm'
import { projectTaskSubject, taskReadSubjectFromDefinition } from '../domain/taskSubject'
import { projectStoredTaskRepositorySummary } from './taskRepositorySurface'

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
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          task: taskReadColumns(db),
          workflowName: workflowNameExpression(db, taskReadColumns(db).workflowId),
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return null
      const repository = projectStoredTaskRepositorySummary(row.task, 'stored')
      return Object.freeze({
        id: row.task.id,
        name: row.task.name,
        ...projectTaskSubject(taskReadSubjectFromDefinition(row.task), row.workflowName),
        repoPath: repository.repoPath,
        repoUrl: repository.repoUrl,
        cachedRepoId: repository.cachedRepoId,
        status: row.task.status,
        startedAt: row.task.startedAt,
        finishedAt: row.task.finishedAt,
        errorSummary: row.task.errorSummary,
        repoCount: repository.repoCount,
        spaceKind: row.task.spaceKind,
        sourceAgentName: row.task.sourceAgentName,
      })
    },
  })
}

export function createDatabaseTaskLifecycleWsProjector(db: PersistenceDb) {
  return createTaskLifecycleWsProjector(createDatabaseTaskLifecycleWsProjection(db))
}
