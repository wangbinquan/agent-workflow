import { and, asc, eq } from 'drizzle-orm'

import { taskCollaborators, taskRepos, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
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
      // RFC-359 W1-T7（P0-1）：显式上下文缺席时读环境上下文（与 SQLite 同规则）。
      const executionContext = input.executionContext ?? currentTaskExecutionContext(input.taskId)
      if (executionContext === undefined) {
        await assertPostgresqlTaskOwnerlessTx(transaction, input.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(transaction, executionContext.token, input.now)
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
