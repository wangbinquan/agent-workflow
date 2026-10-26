import { projectTaskMountReadRow } from './taskRepositorySql'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskAggregateWrite } from './taskDefinitionWriteParticipant'
import { taskMountReadColumns, taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B1 —— TaskEngine drive 快照读取 + 工作区 profile 更新：一份实现，两个 provider 共用。

import { first } from '@/platform/persistence/queryHelpers'

import { and, asc, eq } from 'drizzle-orm'
import { taskSubjectFromDefinition } from '../domain/taskSubject'
import { projectStoredTaskRepositorySurface } from './taskRepositorySurface'
import { taskWorkgroupConfigFromRow } from './taskWorkgroupConfig'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type {
  TaskEngineApplicationPersistence,
  TaskEngineDriveSnapshot,
} from '../application/ports/taskEngineApplicationPersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import { decodeTaskRepositoryMount } from './taskRepositoryCodec'

export class DrizzleTaskEngineApplicationPersistence implements TaskEngineApplicationPersistence {
  constructor(private readonly db: PersistenceDb) {}

  async load(taskId: string): Promise<TaskEngineDriveSnapshot | null> {
    const { taskCollaborators } = tablesOf(this.db)
    const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(this.db)
    const task = await first(
      this.db.select(taskReadColumns(this.db)).from(tasks).where(eq(tasks.id, taskId)).limit(1),
    )
    if (task === undefined) return null
    const repositories = await this.db
      .select(taskMountReadColumns(this.db))
      .from(taskRepos)
      .where(eq(taskRepos.taskId, taskId))
      .orderBy(asc(taskRepos.ordinal))
      .then((rows) => rows.map(projectTaskMountReadRow))
    const collaborators = await this.db
      .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, taskId))
    const mounts = repositories.map(decodeTaskRepositoryMount)
    const {
      repos: _repos,
      spaceNodes: _spaceNodes,
      ...repository
    } = projectStoredTaskRepositorySurface(task, mounts, [], 'stored')
    return {
      task: {
        ...task,
        ...repository,
        subject: taskSubjectFromDefinition(task),
        workgroupConfig: taskWorkgroupConfigFromRow(task),
      },
      repositories: mounts,
      collaborators,
    }
  }

  async findStatus(taskId: string) {
    const { tasks } = tablesOf(this.db)
    return (
      (
        await first(
          this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
        )
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
      await taskAggregateWrite.lockTaskAggregateRoot(transaction, input.taskId)
      const { taskRepositoryMounts: taskRepos } = tablesOf(transaction)
      const rows = await transaction
        .update(taskRepos)
        .set({
          workspaceProfileVersion: input.version,
          workspaceProfileDigest: input.digest,
        })
        .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.ordinal, input.repoIndex)))
        .returning({ repoIndex: taskRepos.ordinal })
      return rows.length === 1
    })
  }
}
