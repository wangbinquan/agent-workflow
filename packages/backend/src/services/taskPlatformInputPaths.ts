// Compatibility entrypoint for legacy callers. The closed grammar is owned by
// the Task Execution domain so the bounded context never imports `services/`.
export {
  normalizeTaskPlatformInputPaths,
  parseTaskPlatformInputPaths,
  TASK_PLATFORM_INPUT_PATH_MAX_LENGTH,
  TASK_PLATFORM_INPUT_PATHS_MAX,
} from '@/modules/task-execution/public/operations'
