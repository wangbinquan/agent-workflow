import type {
  RepositoryGitWorkspaceBinding,
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '../application/ports/repositoryGitWorkspace'
import type { RepositoryGit } from '../application/repositoryCommit'
import { createFileRepositoryGitWorkspaceFactory } from '../infrastructure/local/fileRepositoryGitWorkspace'

export function requireRepositoryGitWorkspaceScope(
  value: unknown,
): asserts value is RepositoryGitWorkspaceScope {
  const methods: readonly (keyof RepositoryGitWorkspaceScope)[] = [
    'run',
    'hasSubmodules',
    'effectiveSubmodules',
    'withPreviewIndex',
    'subrepository',
  ]
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as RepositoryGitWorkspaceScope).workspaceRef !== 'string' ||
    methods.some((name) => typeof (value as RepositoryGitWorkspaceScope)[name] !== 'function')
  ) {
    throw new TypeError('Repository Git requires a complete workspace scope')
  }
}

/** Only an absent selection chooses native; an explicit selection is kept whole. */
export function selectRepositoryGitWorkspaceFactory(
  selected?: RepositoryGitWorkspaceFactory,
  legacyRunGit?: RepositoryGit,
): RepositoryGitWorkspaceFactory {
  const factory =
    selected === undefined ? createFileRepositoryGitWorkspaceFactory(legacyRunGit) : selected
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Repository Git requires a complete workspace factory')
  }
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
