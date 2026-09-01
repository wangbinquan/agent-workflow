import type { Actor } from '@/auth/actor'
import type { TaskAuthorizationQueries } from '@/modules/task-execution/application/ports/taskAuthorization'
import {
  legacySqliteDefaultTaskAuthorizationRef,
  legacySqliteTaskAuthorizationCondition,
  legacySqliteTaskOwnershipScopeCondition,
  legacySqliteVisibleTaskIdsOf,
} from '@/modules/task-execution/infrastructure/legacySqliteTaskAuthorization'

/** Closed actor projection used by provider-selected authorization queries. */
export function taskAuthorizationSubjectOf(actor: Actor) {
  return Object.freeze({
    userId: actor.user.id,
    canReadAllTasks: actor.permissions.has('tasks:read:all'),
  })
}

export async function visibleTaskIds(
  queries: TaskAuthorizationQueries,
  actor: Actor,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  return await queries.visibleTaskIds({ subject: taskAuthorizationSubjectOf(actor), taskIds })
}

// SQLite-only compatibility exports. Provider-neutral production callers use
// `TaskAuthorizationQueries`; these remain while legacy SQLite infrastructure
// consumers are moved behind their owning compositions.
export {
  legacySqliteDefaultTaskAuthorizationRef as defaultTaskAuthorizationRef,
  legacySqliteTaskAuthorizationCondition as taskAuthorizationCondition,
  legacySqliteTaskOwnershipScopeCondition as taskOwnershipScopeCondition,
  legacySqliteVisibleTaskIdsOf as visibleTaskIdsOf,
}
export type {
  LegacySqliteTaskAuthorizationRef as TaskAuthorizationRef,
  LegacyTaskOwnershipScope as TaskOwnershipScope,
} from '@/modules/task-execution/infrastructure/legacySqliteTaskAuthorization'
