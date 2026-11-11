// RFC-476 — collaboration's entry into the per-task review mutation queue (the FIFO that review writes
// and task cancellation share). The queue is task-execution's, offered through the closed-interface
// participant `taskReviewMutationQueue`; collaboration keeps the review-scope resolution (which task a
// review node run belongs to) and its not-found error here, in the callback shape its call sites use.
import { taskReviewMutationQueue } from '@/modules/task-execution/public/participants'
import { NotFoundError } from '@/util/errors'
import type { ReviewMutationScopeResolver } from '../application/ports/reviewMutationScope'
import { DatabaseReviewMutationScopeResolver } from './reviewMutationScope'

/** Serialize one mutation against review state owned by `taskId`. */
export function withTaskReviewMutationLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return taskReviewMutationQueue.serialize(taskId, { run: fn })
}

/** Resolve the immutable task owner, then join that task's mutation queue.
 *
 * RFC-359：两个 provider 都在 async 作用域查询之后进入同一个 per-task FIFO。lookup 发出的同一刻就交给
 * 队列登记为在途解析，于是「先发出者先入队」与 task 键入口同一份规则。 */
export function withReviewNodeMutationLock<T>(
  source:
    | ReviewMutationScopeResolver
    | {
        readonly db: ConstructorParameters<typeof DatabaseReviewMutationScopeResolver>[0]
        readonly taskExecutionParticipants: ConstructorParameters<
          typeof DatabaseReviewMutationScopeResolver
        >[1]
      },
  nodeRunId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const resolver =
    'findTaskId' in source
      ? source
      : new DatabaseReviewMutationScopeResolver(source.db, source.taskExecutionParticipants)
  return taskReviewMutationQueue.serializeAfterLookup(resolver.findTaskId(nodeRunId), {
    run: fn,
    missing: () => {
      throw new NotFoundError('review-not-found', `review run ${nodeRunId} not found`)
    },
  })
}
