// Legacy SQLite lifecycle compatibility operations.
//
// This entrypoint is deliberately narrower than participants.ts: the platform
// lifecycle adapter needs these exact mutation atoms, but must not load the
// human-gate and recovery composition graph just to perform a node CAS. New
// business consumers receive provider-selected TaskExecution ports instead.

import { currentTaskExecutionContext as currentTaskExecutionContextInternal } from '../application/taskExecutionContext'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'

export { assertTaskExecutionContext } from '../application/taskExecutionContext'

/**
 * Compatibility view for the SQLite lifecycle bridge.
 *
 * Deliberately return only the closed public identity instead of exporting the
 * daemon-internal context object (which also owns provider persistence).
 */
export function currentTaskExecutionContext(
  expectedTaskId?: string,
): TaskExecutionContextRef | undefined {
  return currentTaskExecutionContextInternal(expectedTaskId)
}
// RFC-359：`taskExecutionModule` 从这条窄合同上退役。它此前唯一的消费者是
// `platform/persistence/sqlite/taskLifecycle.ts` 的 `ownership.withOwnedTaskTx`——写事务搬到中立
// 的显式边界之后那处消失了。仍需要进程级单例的调用方走 `public/participants` 那一条（它本来就
// 在导出），本文件是「SQLite 生命周期桥接层要的那几个精确原子」，不该顺带背一个组合根单例。
export { fenceTaskWrite, withTaskExecutionWrite } from '../composition/ownedTaskMutation'
export { appendTaskLifecycleTransitionCommittedEventTx } from '../infrastructure/taskLifecycleEventParticipant'
// RFC-359 —— 上面那两个原子的**中立异步孪生**。生命周期桥接层要把写事务从 bun:sqlite 专属的
// 同步面搬到 `databaseSessionFor(db).transaction`，同一批原子因此需要一份 `DatabaseTransaction`
// 上的形态。名字与同步那份区分开（`…InTx`），避免调用点看不出自己在哪一侧。
export { appendTaskLifecycleTransitionCommittedEvent } from '../infrastructure/taskLifecycleCommittedEvents'
export { transitionNodeRunStatusTx as transitionNodeRunStatusInTx } from '../infrastructure/nodeRunLifecycleTransition'
export { withOwnedTaskWrite } from '../infrastructure/taskOwnershipPersistence'
export {
  normalizeTaskPlatformInputPaths,
  parseTaskPlatformInputPaths,
  TASK_PLATFORM_INPUT_PATH_MAX_LENGTH,
  TASK_PLATFORM_INPUT_PATHS_MAX,
} from '../domain/taskPlatformInputPaths'
