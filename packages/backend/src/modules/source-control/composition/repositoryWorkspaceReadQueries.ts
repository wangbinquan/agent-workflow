import type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
import { createFileRepositoryWorkspaceReadQueries } from '../infrastructure/local/fileRepositoryWorkspaceReadQueries'

/** Only absence chooses native. Preserve a selected object's complete receiver. */
export function selectRepositoryWorkspaceReadQueries(
  selected?: RepositoryWorkspaceReadQueries,
): RepositoryWorkspaceReadQueries {
  const queries = selected === undefined ? createFileRepositoryWorkspaceReadQueries() : selected
  const methods: readonly (keyof RepositoryWorkspaceReadQueries)[] = [
    'exists',
    'isGitWorkTree',
    'gitDiffSnapshot',
    'worktreeDiff',
    'isolationRoot',
  ]
  if (
    queries === null ||
    typeof queries !== 'object' ||
    methods.some((name) => typeof queries[name] !== 'function')
  ) {
    throw new TypeError('Repository workspace reads require a complete query implementation')
  }
  return queries
}
