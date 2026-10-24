export interface WorkspaceGcTask {
  readonly taskId: string
  readonly status: string
  readonly spaceKind: string
  readonly workspaceRootRef: string | null
  readonly primary: {
    readonly repoPath: string
    readonly branch: string
    readonly baseBranch: string
  }
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly prune: {
    readonly pruningAt: number | null
    readonly cause: string | null
    readonly prunedAt: number | null
  }
  readonly lifecycleRevision: number
}

export interface WorkspaceGcMount {
  readonly mountPath: string
  readonly repoPath: string
  readonly worktreePath: string
  readonly branch: string
  readonly baseBranch: string
}

export interface TaskWorkspaceGcQueries {
  listGcCandidates(): Promise<readonly WorkspaceGcTask[]>
  listTasks(taskIds: readonly string[]): Promise<readonly WorkspaceGcTask[]>
  listMounts(taskId: string): Promise<readonly WorkspaceGcMount[]>
  existingTaskIds(taskIds: readonly string[]): Promise<ReadonlySet<string>>
  hasLiveOrRevivableChild(taskId: string): Promise<boolean>
  listStaleWebhookClaims(
    staleBefore: number,
  ): Promise<readonly { taskId: string; pruningAt: number }[]>
  listUnstampedTerminalWorkspaces(): Promise<
    readonly { taskId: string; workspaceRootRef: string; lifecycleRevision: number }[]
  >
}

export interface TaskWorkspacePruneCommands {
  claim(taskId: string, now: number, staleClaimBefore: number): Promise<boolean>
  claimIsolation(taskId: string, now: number): Promise<boolean>
  reclaimWebhook(taskId: string, expectedPruningAt: number, now: number): Promise<boolean>
  finalize(taskId: string, now: number): Promise<boolean>
  releaseIsolation(taskId: string, expectedPruningAt?: number): Promise<boolean>
  healMissing(
    taskId: string,
    now: number,
    expected: { workspaceRootRef: string; lifecycleRevision: number },
  ): Promise<boolean>
}
