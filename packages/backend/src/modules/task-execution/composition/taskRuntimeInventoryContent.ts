import type { TaskRuntimeInventoryContent } from '../application/ports/taskRuntimeInventoryContent'

/** RFC-431: the standalone selection reads the run directory's inventory files. */
export { createLocalTaskRuntimeInventoryContent } from '../infrastructure/local/taskRuntimeInventoryContent'

/** Stream adapters persist their observations in the existing node-run column.
 * Before the first report, there is no legacy file to probe on this host. */
export function composeStreamTaskRuntimeInventoryContent(): TaskRuntimeInventoryContent {
  return Object.freeze({ readLive: async () => null })
}
