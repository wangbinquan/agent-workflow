// RFC-359 W1-T2c —— 任务成员/可见性判定的**一份**实现，两个引擎共用。
//
// 此前 `sqliteTaskAuthorization.ts`（同步 DbTxSync 孪生）与 `postgresqlTaskAuthorization.ts`
// 各一份，查询逐字相同。PostgreSQL 那份由本文件替代；SQLite 的同步孪生在其余 dbTxSync
// 调用方迁完前保留（W4 pair-deletion）。

import { and, eq, inArray, or } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, tasks } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationQueries,
  TaskAuthorizationSubject,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

type TaskAuthorizationReader = Pick<ProviderNeutralDatabase, 'select'>

async function visibleIds(
  db: TaskAuthorizationReader,
  subject: TaskAuthorizationSubject,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const visible = new Set<string>()
  for (let offset = 0; offset < taskIds.length; offset += SQL_IN_CHUNK) {
    const chunk = taskIds.slice(offset, offset + SQL_IN_CHUNK)
    if (chunk.length === 0) continue
    const collaboratorIds = db
      .select({ taskId: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, subject.userId))
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          inArray(tasks.id, chunk),
          subject.canReadAllTasks
            ? undefined
            : or(eq(tasks.ownerUserId, subject.userId), inArray(tasks.id, collaboratorIds)),
        ),
      )
    for (const row of rows) visible.add(row.id)
  }
  return visible
}

async function canActOnTask(
  db: TaskAuthorizationReader,
  input: TaskActingMembershipInput,
): Promise<boolean> {
  const rows = await db
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(
      and(eq(taskCollaborators.taskId, input.taskId), eq(taskCollaborators.userId, input.userId)),
    )
  return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
}

function bind(db: TaskAuthorizationReader) {
  return Object.freeze({
    async canViewTask(input: TaskAuthorizationLookupInput) {
      if (input.taskId.length === 0) return false
      return (await visibleIds(db, input.subject, [input.taskId])).has(input.taskId)
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      return await visibleIds(db, input.subject, input.taskIds)
    },
    async canActOnTask(input: TaskActingMembershipInput) {
      return await canActOnTask(db, input)
    },
  })
}

/** 绑定到调用方已经开好的事务（两个引擎同一份判定）。 */
export function createTaskAuthorizationParticipantInTx(
  tx: DatabaseTransaction,
): AsyncTaskAuthorizationParticipantInTx {
  return bind(tx)
}

export function createTaskAuthorizationQueries(
  db: ProviderNeutralDatabase,
): TaskAuthorizationQueries {
  return bind(db)
}
