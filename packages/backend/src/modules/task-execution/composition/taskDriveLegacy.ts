// RFC-332 W2-B compatibility composition for the legacy task admission service.
//
// Keep this as one explicit namespace-import seam: public/commands exposes only
// the durable three-field submission contract.
// RFC-424: the test-only drive entries left services/task.ts, and the re-exports only they used went with them.
// RFC-478: services/task.ts itself is gone (its deferred repository preparation now lives in
// infrastructure/deferredRepositoryPreparation.ts and imports its definition sites), so the re-exports only it used
// went too. What remains serves bootstrap's coordinator factory and room continuation, and two drive helpers that
// tests read.

export {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
export { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
export type { ResolvedTaskDriveConfig } from '../application/drive/taskDriveTypes'

export { createTaskDriveCoordinatorFactory } from '../application/drive/taskDriveCoordinatorFactory'

export { createRoomContinuation } from '../application/drive/roomContinuation'
