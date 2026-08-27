import { asc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { taskRepos, tasks } from '@/db/schema'
import type {
  TaskCallGraphWorkspaceReadModel,
  TaskExecutionReadModels,
  TaskStatusProjectionReadModel,
} from '../application/queries/taskExecutionReadModels'

export function createSqliteTaskExecutionReadModels(db: DbClient): TaskExecutionReadModels {
  const statusProjection: TaskStatusProjectionReadModel = {
    async find(taskId) {
      const row = await db
        .select({
          taskId: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      return row[0] ?? null
    },
  }

  const callGraphWorkspace: TaskCallGraphWorkspaceReadModel = {
    async find(taskId) {
      const taskRows = await db
        .select({ taskId: tasks.id, worktreePath: tasks.worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return null

      const repoRows = await db
        .select({
          worktreeDirName: taskRepos.worktreeDirName,
          worktreePath: taskRepos.worktreePath,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.repoIndex))

      return {
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        // Byte-compatible with getTask's legacy fallback for rows predating
        // task_repos: one root-mounted repository backed by tasks.worktree_path.
        repos:
          repoRows.length > 0
            ? repoRows
            : [{ worktreeDirName: '', worktreePath: task.worktreePath }],
      }
    },
  }

  return Object.freeze({ statusProjection, callGraphWorkspace })
}
