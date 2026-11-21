import { type TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
import { freezeRuntimeBinaryConfiguration } from '../application/operationConfiguration'

/**
 * Read the current binary fallbacks at node-mint time. The resulting values
 * are frozen onto the node run and never re-read by that run. RFC-526: the configuration is the one bootstrap gives every
 * drive (absent: no operation configuration).
 */
export function freezeBinaryConfig(
  configuration: TaskOperationConfigurationQueries | undefined,
): Promise<{ opencodePath?: string | null; claudeCodePath?: string | null } | undefined> {
  return freezeRuntimeBinaryConfiguration(configuration)
}
