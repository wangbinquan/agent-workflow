// RFC-359 W4-B1 —— TaskEngine drive 快照读取 + 工作区 profile 更新：一份实现，两个 provider 共用。

import { and, asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'

import { taskCollaborators, taskRepos, tasks } from '@/db/schema'
import type {
  TaskEngineApplicationPersistence,
  TaskEngineDriveSnapshot,
} from '../application/ports/taskEngineApplicationPersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

export class DrizzleTaskEngineApplicationPersistence implements TaskEngineApplicationPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async load(taskId: string): Promise<TaskEngineDriveSnapshot | null> {
    const task = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).get()
    if (task === undefined) return null
    const repositories = await this.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
      .orderBy(asc(taskRepos.repoIndex))
      .all()
    const collaborators = await this.db
      .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, taskId))
      .all()
    return { task, repositories, collaborators }
  }

  async findStatus(taskId: string) {
    return (
      (
        await this.db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
          .get()
      )?.status ?? null
    )
  }

  async updateWorkspaceProfile(
    input: Parameters<TaskEngineApplicationPersistence['updateWorkspaceProfile']>[0],
  ): Promise<boolean> {
    return await withTaskExecutionWrite(this.db, async (transaction) => {
      await fenceTaskWrite(transaction, {
        taskId: input.taskId,
        context: input.executionContext,
        now: input.now,
      })
      const rows = await transaction
        .update(taskRepos)
        .set({
          workspaceProfileVersion: input.version,
          workspaceProfileDigest: input.digest,
        })
        .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
        .returning({ repoIndex: taskRepos.repoIndex })
      return rows.length === 1
    })
  }
}
