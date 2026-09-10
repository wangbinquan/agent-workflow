// RFC-359 W1-T2c —— 任务成员/可见性判定的**一份**实现，两个引擎共用。
//
// 此前 `sqliteTaskAuthorization.ts`（同步 DbTxSync 孪生）与 `postgresqlTaskAuthorization.ts`
// 各一份，查询逐字相同。PostgreSQL 那份由本文件替代；SQLite 的同步孪生在其余 dbTxSync
// 调用方迁完前保留（W4 pair-deletion）。

import { and, eq } from 'drizzle-orm'

import { visibleTaskIdsFor, type ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationQueries,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

type TaskAuthorizationReader = Pick<ProviderNeutralDatabase, 'select'>

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
      return (await visibleTaskIdsFor(db, input.subject, [input.taskId])).has(input.taskId)
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      return await visibleTaskIdsFor(db, input.subject, input.taskIds)
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
