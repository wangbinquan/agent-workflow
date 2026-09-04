// Process-local serialization for review writes and task cancellation.
//
// Review decisions can mutate sibling review rows and task cancellation seals
// every open review row through the lifecycle terminal hook.  They therefore
// share one FIFO critical section per task.  This is intentionally narrower
// than the general task lifecycle writer: wrapping every setTaskStatus call
// would make review paths re-enter their own lock when they resume a task.

import type { ReviewMutationScopeResolver } from '@/modules/collaboration/application/ports/reviewMutationScope'
import { DatabaseReviewMutationScopeResolver } from '@/modules/collaboration/infrastructure/reviewMutationScope'
import { NotFoundError } from '@/util/errors'

const taskTails = new Map<string, Promise<void>>()
/** 在途的 node_run → task 作用域解析（见 withTaskReviewMutationLock 的排队规则）。 */
const inflightScopeLookups = new Set<Promise<void>>()

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
  // RFC-359：先发出的评审请求可能还在异步解析它的任务作用域（node_run → task）。task 键入口
  // （取消 / 成员变更）先等这些在途解析落队，再登记自己——「先发出者先入队」在两个引擎上
  // 同样成立，而不必依赖 SQLite 才有的同步查询。评审请求自己落队走 enterTaskQueue，不等。
  if (inflightScopeLookups.size > 0) await Promise.allSettled([...inflightScopeLookups])
  return await enterTaskQueue(taskId, fn)
}

async function enterTaskQueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
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

/** Resolve the immutable task owner, then join that task's mutation queue.
 *
 * RFC-359：两个 provider 都在 async 作用域查询之后进入同一个 per-task FIFO（此前 SQLite 有一条
 * 同步 `findTaskIdSync` 入队捷径，PostgreSQL 从来没有）。「先发出者先入队」由
 * withTaskReviewMutationLock 等待在途解析来保证，两个引擎同一份规则。 */
export function withReviewNodeMutationLock<T>(
  source:
    | ReviewMutationScopeResolver
    | ConstructorParameters<typeof DatabaseReviewMutationScopeResolver>[0],
  nodeRunId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const enter = (taskId: string | null): Promise<T> => {
    if (taskId === null) {
      throw new NotFoundError('review-not-found', `review run ${nodeRunId} not found`)
    }
    return enterTaskQueue(taskId, fn)
  }
  const resolver = 'findTaskId' in source ? source : new DatabaseReviewMutationScopeResolver(source)
  const lookup = resolver.findTaskId(nodeRunId)
  // 登记在途解析：`enter` 挂在 lookup 之前，先于任何等它的 task 键入口继续。
  const tracked: Promise<void> = lookup.then(
    () => undefined,
    () => undefined,
  )
  inflightScopeLookups.add(tracked)
  void tracked.finally(() => inflightScopeLookups.delete(tracked))
  return lookup.then(enter)
}
