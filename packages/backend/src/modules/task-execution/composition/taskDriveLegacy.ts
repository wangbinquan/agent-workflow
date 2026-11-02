// RFC-332 W2-B compatibility composition for the legacy task admission service.
//
// Keep this as one explicit namespace-import seam: public/commands exposes only
// the durable three-field submission contract, while services/task.ts still
// owns command-specific preparation/rollback adapters until RFC-294 W4.
// RFC-424: the test-only drive entries left services/task.ts, and the re-exports only they used went with them. What
// remains serves the deferred repository preparation in services/task.ts, bootstrap's coordinator factory and room
// continuation, and two drive helpers that tests read.

export {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
export {
  PersistedRepositoryPreparationStep,
  type RepositoryPreparationDescriptorReader,
} from '../application/drive/repositoryPreparationStep'
export { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
export type { ResolvedTaskDriveConfig } from '../application/drive/taskDriveTypes'
export { isTaskDriverActive } from '../infrastructure/taskDriverLifecycle'

export type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
export {
  prepareDurableRepositoryWorkspace,
  cleanupDurableRepositoryWorkspace,
  acceptDurableRepositoryWorkspace,
} from '../infrastructure/durableRepositoryPreparation'
export { hasDurableRepositoryPreparation } from '../infrastructure/durableRepositoryPreparation'

export { createTaskDriveCoordinatorFactory } from '../application/drive/taskDriveCoordinatorFactory'

export { createRoomContinuation } from '../application/drive/roomContinuation'

export { composeSourceControlTaskPorts } from '../composition'
