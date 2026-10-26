import { projectTaskMountReadRow } from './taskRepositorySql'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, eq } from 'drizzle-orm'
import type { TaskWorktreeLocator } from '../application/ports/taskWorktreeLocator'
import { taskMountReadColumns, taskReadColumns } from './taskRepositorySql'

export function createTaskWorktreeLocator(db: PersistenceDb): TaskWorktreeLocator {
  return {
    async find(taskId) {
      const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
      const [task] = await db
        .select({
          taskId: tasks.id,
          worktreePath: taskReadColumns(db).worktreePath,
          baseCommit: taskReadColumns(db).baseCommit,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (task === undefined) return null
      const repos = await db
        .select({
          ordinal: taskRepos.ordinal,
          workspaceRootRef: taskMountReadColumns(db).workspaceRootRef,
          baseCommit: taskRepos.baseCommit,
          mountPath: taskRepos.mountPath,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.ordinal))
        .then((rows) => rows.map(projectTaskMountReadRow))
      return { ...task, repos }
    },
  }
}
