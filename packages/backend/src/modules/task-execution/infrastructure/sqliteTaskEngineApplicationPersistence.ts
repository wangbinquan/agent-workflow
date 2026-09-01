import { and, asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskCollaborators, taskRepos, tasks } from '@/db/schema'
import { withTaskExecutionMutation } from './sqliteOwnedTaskMutation'
import type {
  TaskEngineApplicationPersistence,
  TaskEngineDriveSnapshot,
} from '../application/ports/taskEngineApplicationPersistence'

export class SqliteTaskEngineApplicationPersistence implements TaskEngineApplicationPersistence {
  constructor(private readonly db: DbClient) {}

  async load(taskId: string): Promise<TaskEngineDriveSnapshot | null> {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (task === undefined) return null
    const repositories = this.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
      .orderBy(asc(taskRepos.repoIndex))
      .all()
    const collaborators = this.db
      .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, taskId))
      .all()
    return { task, repositories, collaborators }
  }

  async findStatus(taskId: string) {
    return (
      this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()
        ?.status ?? null
    )
  }

  async updateWorkspaceProfile(input: {
    readonly taskId: string
    readonly repoIndex: number
    readonly version: number
    readonly digest: string
    readonly executionContext?: Parameters<
      TaskEngineApplicationPersistence['updateWorkspaceProfile']
    >[0]['executionContext']
    readonly now: number
  }): Promise<boolean> {
    return withTaskExecutionMutation({
      db: this.db,
      taskId: input.taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      now: input.now,
      run: (tx) => {
        const exists =
          tx
            .select({ repoIndex: taskRepos.repoIndex })
            .from(taskRepos)
            .where(
              and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)),
            )
            .get() !== undefined
        if (!exists) return false
        tx.update(taskRepos)
          .set({
            workspaceProfileVersion: input.version,
            workspaceProfileDigest: input.digest,
          })
          .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
          .run()
        return true
      },
    })
  }
}
