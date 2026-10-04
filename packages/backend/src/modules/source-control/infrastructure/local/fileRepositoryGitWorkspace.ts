import { join } from 'node:path'
import { runGit as defaultRunGit } from '@/util/git'
import { detectSubmodules, listEffectiveSubmodules } from '@/services/gitSubmodule'
import type { RepositoryGit } from '../../application/repositoryCommit'
import type {
  RepositoryGitWorkspaceBinding,
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from '../../application/ports/repositoryGitWorkspace'
import { createFileRepositoryPreviewIndexPort } from './fileRepositoryPreviewIndex'

/** Native compatibility delegates to the original Git, discovery and index owners. */
export function createFileRepositoryGitWorkspaceFactory(
  runGit: RepositoryGit = defaultRunGit,
): RepositoryGitWorkspaceFactory {
  const bind = (binding: RepositoryGitWorkspaceBinding): RepositoryGitWorkspaceScope => {
    const repoPath = binding.workspaceRef
    return Object.freeze({
      workspaceRef: repoPath,
      run: (args, options) => runGit(repoPath, args as string[], options),
      hasSubmodules: () => detectSubmodules(repoPath),
      // The old CommitPushDeps.runGit hook never replaced native discovery.
      effectiveSubmodules: () => listEffectiveSubmodules(repoPath),
      withPreviewIndex: (operation, options) =>
        createFileRepositoryPreviewIndexPort({ repoPath, runGit, gitOptions: options }).withIndex(
          operation,
        ),
      subrepository: (relativePath) =>
        bind({ ...binding, workspaceRef: join(repoPath, relativePath) }),
    } satisfies RepositoryGitWorkspaceScope)
  }
  return Object.freeze({ bind })
}
