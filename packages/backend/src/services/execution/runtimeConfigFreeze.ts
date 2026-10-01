import {
  freezeRuntimeBinaryConfiguration,
  type TaskOperationConfigurationQueries,
} from '@/modules/task-execution/public/queries'
import { createFileTaskOperationConfiguration } from '@/modules/task-execution/composition'

/**
 * Read the current binary fallbacks at node-mint time. The resulting values
 * are frozen onto the node run and never re-read by that run.
 */
export function freezeBinaryConfig(
  configPath: string | undefined,
  configuration?: TaskOperationConfigurationQueries,
): Promise<{ opencodePath?: string | null; claudeCodePath?: string | null } | undefined> {
  return freezeRuntimeBinaryConfiguration(
    configuration ??
      (configPath === undefined || configPath === ''
        ? undefined
        : createFileTaskOperationConfiguration(configPath)),
  )
}
