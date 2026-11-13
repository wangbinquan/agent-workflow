import type { TaskRuntimeInventoryContent } from '../application/ports/taskRuntimeInventoryContent'

// RFC-491: the standalone selection's run-directory read moved to runtime-management
// (`composition/taskRuntimeInventoryContent.ts`); bootstrap binds it to this port.

/** Stream adapters persist their observations in the existing node-run column.
 * Before the first report, there is no legacy file to probe on this host. */
export function composeStreamTaskRuntimeInventoryContent(): TaskRuntimeInventoryContent {
  return Object.freeze({ readLive: async () => null })
}
