import { eq, asc } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskWorktreeLocator } from '../application/ports/taskWorktreeLocator'

export function createTaskWorktreeLocator(db: PersistenceDb): TaskWorktreeLocator {
  return {
    async find(taskId) {
      const { tasks, taskRepos } = tablesOf(db)
      const [task] = await db
        .select({
          taskId: tasks.id,
          worktreePath: tasks.worktreePath,
          baseCommit: tasks.baseCommit,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (task === undefined) return null
      const repos = await db
        .select({
          ordinal: taskRepos.repoIndex,
          worktreePath: taskRepos.worktreePath,
          baseCommit: taskRepos.baseCommit,
          mountPath: taskRepos.mountPath,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.repoIndex))
      return { ...task, repos }
    },
  }
}
