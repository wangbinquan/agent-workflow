import type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
import { requireRepositoryWorkspaceReadQueries } from '../application/workspacePorts'

/** The caller's selection is required (RFC-527); preserve its complete receiver. */
export function selectRepositoryWorkspaceReadQueries(
  selected: RepositoryWorkspaceReadQueries,
): RepositoryWorkspaceReadQueries {
  requireRepositoryWorkspaceReadQueries(selected)
  return selected
}
