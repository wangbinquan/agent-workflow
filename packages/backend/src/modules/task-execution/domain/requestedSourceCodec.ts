/** The persisted source is deployment-neutral; Task owns its creation and conversion. */
export {
  REQUESTED_SOURCE_CODEC,
  decodeRequestedSourceJson,
  encodeRequestedSource,
  requestedSourceAtCreation,
  requestedSourcePrimary,
  requestedSourceView,
  type PersistedRequestedSource,
  type TaskRequestedSourceInput,
} from '@/platform/taskRepository'
