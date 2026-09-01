import { and, eq, inArray, or } from 'drizzle-orm'

import { taskCollaborators, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationQueries,
  TaskAuthorizationSubject,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'
import type { PostgresqlTaskExecutionTransaction } from './postgresqlTaskLifecycleTransaction'

type PostgresqlTaskAuthorizationReader = Pick<PostgresqlDatabaseClient, 'select'>

async function visibleIds(
  db: PostgresqlTaskAuthorizationReader,
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

/** Bind task authorization to an already-reserved PostgreSQL transaction. */
export function createPostgresqlTaskAuthorizationParticipantInTx(
  tx: PostgresqlTaskExecutionTransaction,
): AsyncTaskAuthorizationParticipantInTx {
  return Object.freeze({
    async canViewTask(input: TaskAuthorizationLookupInput) {
      return (await visibleIds(tx, input.subject, [input.taskId])).has(input.taskId)
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      return await visibleIds(tx, input.subject, input.taskIds)
    },
    async canActOnTask(input: TaskActingMembershipInput) {
      const rows = await tx
        .select({ role: taskCollaborators.role })
        .from(taskCollaborators)
        .where(
          and(
            eq(taskCollaborators.taskId, input.taskId),
            eq(taskCollaborators.userId, input.userId),
          ),
        )
      return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
    },
  })
}

export function createPostgresqlTaskAuthorizationQueries(
  db: PostgresqlDatabaseClient,
): TaskAuthorizationQueries {
  return Object.freeze({
    async canViewTask(input: TaskAuthorizationLookupInput) {
      return (await visibleIds(db, input.subject, [input.taskId])).has(input.taskId)
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      return await visibleIds(db, input.subject, input.taskIds)
    },
    async canActOnTask(input: TaskActingMembershipInput) {
      const rows = await db
        .select({ role: taskCollaborators.role })
        .from(taskCollaborators)
        .where(
          and(
            eq(taskCollaborators.taskId, input.taskId),
            eq(taskCollaborators.userId, input.userId),
          ),
        )
      return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
    },
  })
}
