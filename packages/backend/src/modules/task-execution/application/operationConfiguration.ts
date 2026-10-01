import type { TaskOperationConfigurationQueries } from './ports/taskOperationConfiguration'

export async function freezeRuntimeBinaryConfiguration(
  queries: TaskOperationConfigurationQueries | undefined,
): Promise<{ opencodePath?: string | null; claudeCodePath?: string | null } | undefined> {
  if (queries === undefined) return undefined
  try {
    const current = await queries.readBinaryPaths()
    return {
      opencodePath: current.opencodePath ?? null,
      claudeCodePath: current.claudeCodePath ?? null,
    }
  } catch {
    return undefined
  }
}

export async function readTaskCommitExcludePatterns(
  queries: TaskOperationConfigurationQueries | undefined,
  launchFallback: readonly string[],
): Promise<readonly string[]> {
  if (queries !== undefined) {
    try {
      return [...(await queries.readCommitExcludePatterns())]
    } catch {
      // Preserve the launch snapshot when the current settings cannot be read.
    }
  }
  return [...launchFallback]
}
