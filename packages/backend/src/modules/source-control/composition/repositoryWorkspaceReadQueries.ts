import type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
import { requireRepositoryWorkspaceReadQueries } from '../application/workspacePorts'
import { createFileRepositoryWorkspaceReadQueries } from '../infrastructure/local/fileRepositoryWorkspaceReadQueries'

/** Only absence chooses native. Preserve a selected object's complete receiver. */
export function selectRepositoryWorkspaceReadQueries(
  selected?: RepositoryWorkspaceReadQueries,
): RepositoryWorkspaceReadQueries {
  const queries = selected === undefined ? createFileRepositoryWorkspaceReadQueries() : selected
  requireRepositoryWorkspaceReadQueries(queries)
  return queries
}
