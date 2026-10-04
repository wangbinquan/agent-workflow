import type { RepositoryGitOptions, RepositoryGitOutcome } from './repositoryGitWorkspace'

type Completion<T> = T | Promise<T>

/** One complete physical conflict-scene owner; references belong to its implementation. */
export interface ConflictMergeWorkspaceEffects {
  allocate(storageRootReference?: string): Completion<string>
  cloneBaseline(
    workspaceReference: string,
    baselineReference: string,
  ): Promise<RepositoryGitOutcome>
  run(
    workspaceReference: string,
    args: readonly string[],
    options?: RepositoryGitOptions,
  ): Promise<RepositoryGitOutcome>
  installPlatformExclude(workspaceReference: string): Completion<void>
  readConflictFile(workspaceReference: string, relativePath: string): Completion<string | null>
  mergeHeadExists(workspaceReference: string): Completion<boolean>
  discard(workspaceReference: string): Completion<void>
}
