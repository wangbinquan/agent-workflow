import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '../composition/humanGate'
import type { SchedulerDriverPort } from '../application/ports/taskExecutionTopology'

export type {
  ChildResumeRuntime,
  InheritableRunConfig,
  SchedulerDriverPort,
  TaskDriveRequest,
  TaskDriveRuntimeKnobs,
  TaskDriveRuntimeOptions,
  TaskExecutionContextRef,
  TaskExecutionTopologyLogger,
} from '../application/ports/taskExecutionTopology'
export {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
} from '../application/ports/taskExecutionTopology'

export {
  taskDriveSubmission,
  type TaskDriveCompletionMode,
  type TaskDriveCoordinator,
  type TaskDriveReceipt,
  type TaskDriveSubmission,
} from '../application/drive/taskDriveTypes'

// RFC-333 temporary legacy-facing command seam. The service bridge supplies
// the required participant; consumers never reach task-execution internals.
export const parkPreparedHumanGate = parkPreparedHumanGateInternal

/** Bootstrap must supply one daemon-scoped driver to every command caller. */
export function requireSchedulerDriver(
  driver: SchedulerDriverPort | undefined,
): SchedulerDriverPort {
  if (driver === undefined) throw new Error('task-execution-driver-not-composed')
  return driver
}
