import type {
  RepositoryGitWorkspaceBinding,
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '../application/ports/repositoryGitWorkspace'
import {
  requireRepositoryGitWorkspaceFactory,
  requireRepositoryGitWorkspaceScope,
} from '../application/workspacePorts'
export { requireRepositoryGitWorkspaceScope } from '../application/workspacePorts'

/** The caller's selection is required and kept whole; selection only checks it (RFC-527). */
export function selectRepositoryGitWorkspaceFactory(
  selected: RepositoryGitWorkspaceFactory,
): RepositoryGitWorkspaceFactory {
  requireRepositoryGitWorkspaceFactory(selected)
  return selected
}

export function bindRepositoryGitWorkspace(
  factory: RepositoryGitWorkspaceFactory,
  binding: RepositoryGitWorkspaceBinding,
): RepositoryGitWorkspaceScope {
  const scope = factory.bind(binding)
  requireRepositoryGitWorkspaceScope(scope)
  return scope
}

export function bindRepositoryGitSubworkspace(
  parent: RepositoryGitWorkspaceScope,
  relativePath: string,
): RepositoryGitWorkspaceScope {
  const scope = parent.subrepository(relativePath)
  requireRepositoryGitWorkspaceScope(scope)
  return scope
}
