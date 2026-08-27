// RFC-332 W2-B compatibility composition for the legacy task admission service.
//
// Keep this as one explicit namespace-import seam: public/commands exposes only
// the durable three-field submission contract, while services/task.ts still
// owns command-specific preparation/rollback adapters until RFC-294 W4.

export {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
  type RepositoryPreparationStep,
  type TaskDriveFailureReporter,
} from '../application/drive/taskDriveCoordinator'
export {
  PersistedRepositoryPreparationStep,
  type RepositoryPreparationDescriptorReader,
} from '../application/drive/repositoryPreparationStep'
export { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
export {
  activeTaskDriverController,
  clearTaskDriverLifecycleForTesting,
  createTaskDriverLifecyclePort,
  isTaskDriverActive,
} from '../infrastructure/taskDriverLifecycle'
