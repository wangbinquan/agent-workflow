// Process-local serialization for review writes and task cancellation.
//
// Review decisions can mutate sibling review rows and task cancellation seals
// every open review row through the lifecycle terminal hook.  They therefore
// share one FIFO critical section per task.  This is intentionally narrower
// than the general task lifecycle writer: wrapping every setTaskStatus call
// would make review paths re-enter their own lock when they resume a task.

import type { ReviewMutationScopeResolver } from '@/modules/collaboration/application/ports/reviewMutationScope'
import { SqliteReviewMutationScopeResolver } from '@/modules/collaboration/infrastructure/sqliteReviewMutationScope'
import { NotFoundError } from '@/util/errors'

const taskTails = new Map<string, Promise<void>>()

/** Test-only visibility for broadcaster re-entry regression coverage. */
export function __hasTaskReviewMutationQueueForTesting(taskId: string): boolean {
  return taskTails.has(taskId)
}

/**
 * Serialize one mutation against review state owned by `taskId`.
 *
 * The tail represents only the release gate, not the callback result, so a
 * rejected callback cannot poison later waiters.  The last waiter removes the
 * registry entry; earlier holders leave a later tail intact.
 */
export async function withTaskReviewMutationLock<T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = taskTails.get(taskId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prior.catch(() => {}).then(() => gate)
  taskTails.set(taskId, tail)
  await prior.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (taskTails.get(taskId) === tail) taskTails.delete(taskId)
  }
}

/** Resolve the immutable task owner, then join that task's mutation queue. */
export function withReviewNodeMutationLock<T>(
  source:
    | ReviewMutationScopeResolver
    | ConstructorParameters<typeof SqliteReviewMutationScopeResolver>[0],
  nodeRunId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const enter = (taskId: string | null): Promise<T> => {
    if (taskId === null) {
      throw new NotFoundError('review-not-found', `review run ${nodeRunId} not found`)
    }
    return withTaskReviewMutationLock(taskId, fn)
  }
  if ('findTaskId' in source) return source.findTaskId(nodeRunId).then(enter)

  // The legacy SQLite compatibility path can resolve the immutable scope
  // synchronously. Enter its FIFO in this call stack so a following membership
  // mutation cannot overtake a review request merely because Promise.resolve
  // inserted a microtask between invocation and queue registration. Provider
  // implementations remain Promise-only and join after their async lookup.
  return enter(new SqliteReviewMutationScopeResolver(source).findTaskIdSync(nodeRunId))
}
