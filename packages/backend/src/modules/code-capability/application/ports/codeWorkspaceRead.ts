// RFC-349 — purpose-specific task/workspace projection for structural-diff and
// code-intelligence reads. The code-capability application never receives a
// database client or a task table row.

export interface CodeWorkspaceRepository {
  readonly mountPath: string
  readonly worktreeDirName: string
  readonly worktreePath: string
  readonly baseCommit: string | null
}

export interface CodeWorkspaceTask {
  readonly id: string
  readonly status: string
  readonly spaceKind: string
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly repoCount: number
  readonly repos: readonly CodeWorkspaceRepository[]
}

export interface CodeNodeRunSnapshot {
  readonly id: string
  readonly preSnapshot: string | null
  readonly preSnapshotReposJson: string | null
  readonly startedAt: number | null
  readonly wrapperProgressJson: string | null
}

export interface CodeWorkspaceRead {
  findTask(taskId: string): Promise<CodeWorkspaceTask | null>
  listNodeRuns(taskId: string): Promise<readonly CodeNodeRunSnapshot[]>
  findNodeRun(nodeRunId: string): Promise<CodeNodeRunSnapshot | null>
}
