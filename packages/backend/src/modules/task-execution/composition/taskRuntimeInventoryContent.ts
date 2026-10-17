import type { TaskRuntimeInventoryContent } from '../application/ports/taskRuntimeInventoryContent'
import { createLocalTaskRuntimeInventoryContent } from '../infrastructure/local/taskRuntimeInventoryContent'

export function composeTaskRuntimeInventoryContent(
  selected?: TaskRuntimeInventoryContent,
): TaskRuntimeInventoryContent {
  return selected ?? createLocalTaskRuntimeInventoryContent()
}

/** Stream adapters persist their observations in the existing node-run column.
 * Before the first report, there is no legacy file to probe on this host. */
export function composeStreamTaskRuntimeInventoryContent(): TaskRuntimeInventoryContent {
  return Object.freeze({ readLive: async () => null })
}
