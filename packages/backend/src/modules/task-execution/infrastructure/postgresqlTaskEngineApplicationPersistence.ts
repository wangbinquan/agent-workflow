import { and, asc, eq } from 'drizzle-orm'

import { taskCollaborators, taskRepos, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  TaskEngineApplicationPersistence,
  TaskEngineDriveSnapshot,
} from '../application/ports/taskEngineApplicationPersistence'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

export class PostgresqlTaskEngineApplicationPersistence implements TaskEngineApplicationPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

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
    return await withPostgresqlSerializableTaskExecution(this.db, async (transaction) => {
      if (input.executionContext === undefined) {
        await assertPostgresqlTaskOwnerlessTx(transaction, input.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(transaction, input.executionContext.token, input.now)
      }
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
