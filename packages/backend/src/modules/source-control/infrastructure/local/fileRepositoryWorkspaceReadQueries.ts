import { isoKeyOf, isoWorktreePathFor } from '@/platform/workspace/local/isolationReferences'
import { gitDiffSnapshot, isGitWorkTree, worktreeDiff } from '@/util/git'
import type { RepositoryWorkspaceReadQueries } from '../../application/ports/repositoryWorkspaceReadQueries'
import { createFileWorkspacePresenceQueries } from './fileWorkspacePresence'

/** The existing native readers and isolation address rules remain the sole mechanism. */
export function createFileRepositoryWorkspaceReadQueries(): RepositoryWorkspaceReadQueries {
  const presence = createFileWorkspacePresenceQueries()
  return Object.freeze({
    exists: (workspaceRef: string) => presence.exists(workspaceRef),
    isGitWorkTree,
    gitDiffSnapshot,
    worktreeDiff,
    isolationRoot: (input: Parameters<RepositoryWorkspaceReadQueries['isolationRoot']>[0]) =>
      isoWorktreePathFor(
        input.storageRootRef,
        input.taskId,
        isoKeyOf(input.persistedWorkspaceRef, input.nodeRunId),
        '',
      ),
  })
}
