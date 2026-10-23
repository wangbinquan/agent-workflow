// RFC-359 W4-B1 —— 回滚目标投影：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份逐字相同）。

import { projectStoredTaskRepositorySurface } from './taskRepositorySurface'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  TaskRollbackQueries,
  TaskRollbackTargetSnapshot,
} from '../application/ports/taskRollbackQueries'

export class DrizzleTaskRollbackQueries implements TaskRollbackQueries {
  constructor(private readonly db: PersistenceDb) {}

  async load(taskId: string): Promise<TaskRollbackTargetSnapshot | null> {
    const { tasks, taskRepos } = tablesOf(this.db)
    const taskRows = await this.db
      .select({
        taskId: tasks.id,
        worktreePath: tasks.worktreePath,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (task === undefined) return null

    const repositoryRows = await this.db
      .select({
        worktreePath: taskRepos.worktreePath,
        mountPath: taskRepos.mountPath,
      })
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
      .orderBy(asc(taskRepos.repoIndex))

    return Object.freeze({
      taskId: task.taskId,
      worktreePath: task.worktreePath,
      repositories: Object.freeze(
        repositoryRows.length > 0
          ? repositoryRows.map((repository) => Object.freeze({ ...repository }))
          : projectStoredTaskRepositorySurface(task).repos.map(({ worktreePath, mountPath }) =>
              Object.freeze({ worktreePath, mountPath }),
            ),
      ),
    })
  }
}
