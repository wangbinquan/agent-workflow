import type { SQL, SQLWrapper } from 'drizzle-orm'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { taskCollaborators, tasks } from '@/db/schema'

/**
 * Minimal column contract used by task-list queries. Accepting SQLWrapper keeps
 * the predicate reusable for both Drizzle tables and fixed, trusted CTE aliases.
 */
export interface TaskAuthorizationRef {
  id: SQLWrapper
  ownerUserId: SQLWrapper
}

export type TaskOwnershipScope = 'all' | 'mine' | 'shared'

export function taskAuthorizationCondition(
  db: DbClient,
  ref: TaskAuthorizationRef,
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

export function taskOwnershipScopeCondition(
  db: DbClient,
  ref: TaskAuthorizationRef,
  actorUserId: string,
  scope: TaskOwnershipScope,
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
    return and(collaborator, ne(ref.ownerUserId, actorUserId))!
  }
  return or(eq(ref.ownerUserId, actorUserId), collaborator)!
}

export function defaultTaskAuthorizationRef(): TaskAuthorizationRef {
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}
