// Process-local serialization for review writes and task cancellation.
//
// Review decisions can mutate sibling review rows and task cancellation seals
// every open review row through the lifecycle terminal hook.  They therefore
// share one FIFO critical section per task.  This is intentionally narrower
// than the general task lifecycle writer: wrapping every setTaskStatus call
// would make review paths re-enter their own lock when they resume a task.
//
// RFC-476: moved from `services/reviewMutationCoordinator.ts` into task-execution — the queue is per-task
// write serialization. task-execution's cancellation, driver attach, source termination and engine call the
// functions below directly; collaboration (review writes, collaborator changes) enters through the
// closed-interface participant `taskReviewMutationQueue` (`public/participants`) and keeps its own
// review-scope resolution (node run → task) and not-found error.

import type {
  TaskReviewMutation,
  TaskReviewMutationQueue,
  TaskReviewScopedMutation,
} from '../application/ports/taskReviewMutationQueue'

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
/**
 * RFC-359 —— **在发出的那一刻**把排队位置定下来，之后再做 I/O 也不会改变它。
 *
 * 「先发出者先入队」的判据是：**我被发出时，有哪些评审作用域解析已经在途**。
 * 那是一个**同步可知**的事实——评审侧本来就是同步登记的
 *（collaboration 的 `withReviewNodeMutationLock` 经 `serializeAfterTaskLookup` 在发出 lookup 的同一刻就 `inflightScopeLookups.add(tracked)`）。
 * 这里把它快照下来，于是 task 键入口（取消 / 成员变更）可以先取号、再 await 自己的前置读，
 * 排队结果与「取号后立刻入队」完全一致。
 *
 * 为什么非这样不可：在此之前，取消侧的顺序**只能靠调用方在到达本函数之前一次都不让出**来保证，
 * 而那恰恰是**只有 bun:sqlite 同步读才能做到**的事——正是 RFC-359 要消灭的
 * 「一个引擎对、另一个引擎错」。把取号拆出来之后，两个引擎走同一条规则。
 */
export function reserveTaskReviewMutationSlot(
  taskId: string,
): <T>(fn: () => Promise<T>) => Promise<T> {
  // 取号即快照。这一刻的事实只有两种，且**同步可判**：
  const priorScopeLookups = inflightScopeLookups.size > 0 ? [...inflightScopeLookups] : []
  if (priorScopeLookups.length === 0) {
    // ① 没有在途的评审作用域解析 ⇒ 我就是当前最先发出的那个：**同步占住队尾**。
    //    后来者（无论 task 键入口还是评审）都排在我后面，与我之后 await 多久无关。
    return claimTaskQueueSlot(taskId)
  }
  // ② 有在途解析 ⇒ 那些评审**比我先发出**，必须让它们先落队；等它们落定我再登记。
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await Promise.allSettled(priorScopeLookups)
    return await enterTaskQueue(taskId, fn)
  }
}

export async function withTaskReviewMutationLock<T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // 同步调用方的行为逐字不变：取号与入队之间没有 await。
  return await reserveTaskReviewMutationSlot(taskId)(fn)
}

/**
 * 同步占住队尾，返回「轮到我时跑 `fn`」。
 *
 * 这是 `enterTaskQueue` 原来那段的**同一份**逻辑，只是把「登记队尾」与「等前一位」拆成两步：
 * 登记在调用的那一刻同步完成，等待留给返回的函数。`enterTaskQueue` 现在就是
 * 「登记后立刻等」，行为与拆分前逐字相同。
 */
function claimTaskQueueSlot(taskId: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const prior = taskTails.get(taskId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = prior.catch(() => {}).then(() => gate)
  taskTails.set(taskId, tail)
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await prior.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (taskTails.get(taskId) === tail) taskTails.delete(taskId)
    }
  }
}

async function enterTaskQueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return await claimTaskQueueSlot(taskId)(fn)
}

/** Resolve the immutable task owner, then join that task's mutation queue.
 *
 * RFC-359：两个 provider 都在 async 作用域查询之后进入同一个 per-task FIFO（此前 SQLite 有一条
 * 同步 `findTaskIdSync` 入队捷径，PostgreSQL 从来没有）。「先发出者先入队」由
 * withTaskReviewMutationLock 等待在途解析来保证，两个引擎同一份规则。
 *
 * RFC-476：作用域解析（node run → task）与找不到时的错误归 collaboration（它的
 * `withReviewNodeMutationLock` 发出 lookup 后立刻交给这里）；这里只登记在途解析并在解析出任务后入队。 */
export function serializeAfterTaskLookup<T>(
  lookup: Promise<string | null>,
  mutation: TaskReviewScopedMutation<T>,
): Promise<T> {
  // 登记在途解析：入队挂在 lookup 之后，先于任何等它的 task 键入口继续。
  const tracked: Promise<void> = lookup.then(
    () => undefined,
    () => undefined,
  )
  inflightScopeLookups.add(tracked)
  void tracked.finally(() => inflightScopeLookups.delete(tracked))
  return lookup.then((taskId) =>
    taskId === null ? mutation.missing() : enterTaskQueue(taskId, () => mutation.run()),
  )
}

/** RFC-476 — the queue above as a closed-interface participant for collaboration. */
export const taskReviewMutationQueue: TaskReviewMutationQueue = Object.freeze({
  serialize: <T>(taskId: string, mutation: TaskReviewMutation<T>): Promise<T> =>
    withTaskReviewMutationLock(taskId, () => mutation.run()),
  serializeAfterLookup: <T>(
    lookup: Promise<string | null>,
    mutation: TaskReviewScopedMutation<T>,
  ): Promise<T> => serializeAfterTaskLookup(lookup, mutation),
})
