import type { SQL, SQLWrapper } from 'drizzle-orm'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { taskCollaborators, tasks } from '@/db/schema'
import { chunkedAll } from '@/util/sqlChunk'

/** SQLite-only predicate compatibility while callers move to closed ports. */
export interface LegacySqliteTaskAuthorizationRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
}

export type LegacyTaskOwnershipScope = 'all' | 'mine' | 'shared'

export function legacySqliteTaskAuthorizationCondition(
  db: DbClient,
  ref: LegacySqliteTaskAuthorizationRef,
  actor: Actor,
): SQL<unknown> {
  if (actor.permissions.has('tasks:read:all')) return sql`1 = 1`
  const collaborator = inArray(
    ref.id,
    db
      .select({ id: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, actor.user.id)),
  )
  return or(eq(ref.ownerUserId, actor.user.id), collaborator)!
}

export function legacySqliteTaskOwnershipScopeCondition(
  db: DbClient,
  ref: LegacySqliteTaskAuthorizationRef,
  actorUserId: string,
  scope: LegacyTaskOwnershipScope,
): SQL<unknown> {
  if (scope === 'all') return sql`1 = 1`
  const collaborator = inArray(
    ref.id,
    db
      .select({ id: taskCollaborators.taskId })
      .from(taskCollaborators)
      .where(eq(taskCollaborators.userId, actorUserId)),
  )
  if (scope === 'shared') {
    return and(collaborator, or(isNull(ref.ownerUserId), ne(ref.ownerUserId, actorUserId)))!
  }
  return or(eq(ref.ownerUserId, actorUserId), collaborator)!
}

export function legacySqliteDefaultTaskAuthorizationRef(): LegacySqliteTaskAuthorizationRef {
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}

export async function legacySqliteVisibleTaskIdsOf(
  db: DbClient,
  actor: Actor,
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const readsAll = actor.permissions.has('tasks:read:all')
  const rows = await chunkedAll(taskIds, (chunk) =>
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        readsAll
          ? inArray(tasks.id, chunk)
          : and(
              inArray(tasks.id, chunk),
              legacySqliteTaskAuthorizationCondition(
                db,
                legacySqliteDefaultTaskAuthorizationRef(),
                actor,
              ),
            ),
      ),
  )
  return new Set(rows.map((row) => row.id))
}
