import { and, eq, inArray, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { taskCollaborators, tasks } from '@/db/schema'
import { SQL_IN_CHUNK } from '@/util/sqlChunk'
import type {
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationParticipantInTx,
  TaskAuthorizationQueries,
  TaskAuthorizationSubject,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

function canActOnTaskSync(tx: DbTxSync, input: TaskActingMembershipInput): boolean {
  const rows = tx
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(
      and(eq(taskCollaborators.taskId, input.taskId), eq(taskCollaborators.userId, input.userId)),
    )
    .all()
  return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
}

function visibleIdsSync(
  tx: DbTxSync,
  subject: TaskAuthorizationSubject,
  taskIds: readonly string[],
): ReadonlySet<string> {
  const visible = new Set<string>()
  for (let offset = 0; offset < taskIds.length; offset += SQL_IN_CHUNK) {
    const chunk = taskIds.slice(offset, offset + SQL_IN_CHUNK)
    if (chunk.length === 0) continue
    const collaboratorIds = tx
      .select({ taskId: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, subject.userId))
    const rows = tx
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
      .all()
    for (const row of rows) visible.add(row.id)
  }
  return visible
}

/** Bind task authorization to an already-open SQLite transaction. */
export function createSqliteTaskAuthorizationParticipantInTx(
  tx: DbTxSync,
): TaskAuthorizationParticipantInTx {
  return Object.freeze({
    canViewTask(input: TaskAuthorizationLookupInput) {
      return visibleIdsSync(tx, input.subject, [input.taskId]).has(input.taskId)
    },
    visibleTaskIds(input: VisibleTaskIdsInput) {
      return visibleIdsSync(tx, input.subject, input.taskIds)
    },
    canActOnTask(input: TaskActingMembershipInput) {
      return canActOnTaskSync(tx, input)
    },
  })
}

export function createSqliteTaskAuthorizationQueries(db: DbClient): TaskAuthorizationQueries {
  return Object.freeze({
    async canViewTask(input: TaskAuthorizationLookupInput) {
      if (input.taskId.length === 0) return false
      const collaboratorIds = db
        .select({ taskId: taskCollaborators.taskId })
        .from(taskCollaborators)
        .where(eq(taskCollaborators.userId, input.subject.userId))
      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, input.taskId),
            input.subject.canReadAllTasks
              ? undefined
              : or(eq(tasks.ownerUserId, input.subject.userId), inArray(tasks.id, collaboratorIds)),
          ),
        )
        .limit(1)
      return rows[0] !== undefined
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      const visible = new Set<string>()
      for (let offset = 0; offset < input.taskIds.length; offset += SQL_IN_CHUNK) {
        const chunk = input.taskIds.slice(offset, offset + SQL_IN_CHUNK)
        if (chunk.length === 0) continue
        const collaboratorIds = db
          .select({ taskId: taskCollaborators.taskId })
          .from(taskCollaborators)
          .where(eq(taskCollaborators.userId, input.subject.userId))
        const rows = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              inArray(tasks.id, chunk),
              input.subject.canReadAllTasks
                ? undefined
                : or(
                    eq(tasks.ownerUserId, input.subject.userId),
                    inArray(tasks.id, collaboratorIds),
                  ),
            ),
          )
        for (const row of rows) visible.add(row.id)
      }
      return visible
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
