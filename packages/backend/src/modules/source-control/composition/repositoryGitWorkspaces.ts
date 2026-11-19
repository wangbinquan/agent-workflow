import type {
  RepositoryGitWorkspaceBinding,
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '../application/ports/repositoryGitWorkspace'
import type { RepositoryGit } from '../application/repositoryCommit'
import {
  requireRepositoryGitWorkspaceFactory,
  requireRepositoryGitWorkspaceScope,
} from '../application/workspacePorts'
export { requireRepositoryGitWorkspaceScope } from '../application/workspacePorts'
import { createFileRepositoryGitWorkspaceFactory } from '../infrastructure/local/fileRepositoryGitWorkspace'

/** Only an absent selection chooses native; an explicit selection is kept whole. */
export function selectRepositoryGitWorkspaceFactory(
  selected?: RepositoryGitWorkspaceFactory,
  legacyRunGit?: RepositoryGit,
): RepositoryGitWorkspaceFactory {
  const factory =
    selected === undefined ? createFileRepositoryGitWorkspaceFactory(legacyRunGit) : selected
  requireRepositoryGitWorkspaceFactory(factory)
  return factory
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
