import type { WorkspacePresenceQueries } from './workspacePresence'

/** Read references are interpreted only by the selected workspace implementation. */
export interface RepositoryWorkspaceReadQueries extends WorkspacePresenceQueries {
  isGitWorkTree(workspaceRef: string): boolean | Promise<boolean>
  gitDiffSnapshot(workspaceRef: string, fromCommit: string): Promise<string>
  worktreeDiff(
    workspaceRef: string,
    fromCommit: string,
  ): Promise<{ diff: string; truncated: boolean }>
  /** Derive the existing isolation reference without creating or restoring it. */
  isolationRoot(input: {
    storageRootRef: string
    taskId: string
    nodeRunId: string
    persistedWorkspaceRef: string | null
  }): string | Promise<string>
}
