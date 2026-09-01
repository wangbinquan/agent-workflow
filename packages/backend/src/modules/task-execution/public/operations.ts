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
export { taskExecutionModule } from '../composition'
export { withTaskExecutionMutation } from '../composition/sqliteOwnedTaskMutation'
export { appendTaskLifecycleTransitionCommittedEventTx } from '../infrastructure/taskLifecycleEventParticipant'
export {
  normalizeTaskPlatformInputPaths,
  parseTaskPlatformInputPaths,
  TASK_PLATFORM_INPUT_PATH_MAX_LENGTH,
  TASK_PLATFORM_INPUT_PATHS_MAX,
} from '../domain/taskPlatformInputPaths'
