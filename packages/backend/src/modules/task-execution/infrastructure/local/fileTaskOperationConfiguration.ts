import { loadConfig } from '@/platform/configuration/fileConfiguration'
import type { TaskOperationConfigurationQueries } from '../../application/ports/taskOperationConfiguration'

export function createFileTaskOperationConfiguration(
  configPath: string,
): TaskOperationConfigurationQueries {
  return Object.freeze({
    readBinaryPaths() {
      const current = loadConfig(configPath)
      return {
        opencodePath: current.opencodePath ?? null,
        claudeCodePath: current.claudeCodePath ?? null,
      }
    },
    readCommitExcludePatterns: () => loadConfig(configPath).taskCommitExcludePatterns,
  })
}
