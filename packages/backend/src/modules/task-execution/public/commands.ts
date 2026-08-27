import { parkPreparedHumanGate as parkPreparedHumanGateInternal } from '../composition/humanGate'

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
