import type {
  MaintenanceMemberSnapshot,
  RecoverableTerminalMaintenanceClaim,
  TerminalMaintenanceClaim,
  TerminalMaintenanceOperation,
  TerminalMaintenanceState,
} from '@/modules/task-execution/public/participants'

export interface WorkspaceTaskRecord {
  readonly id: string
  readonly status: string
  readonly repoPath: string
  readonly worktreePath: string
  readonly branch: string
  readonly baseBranch: string
  readonly spaceKind: string
  readonly repoCount: number
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly workspacePruningAt: number | null
  readonly workspacePruneCause: string | null
  readonly workspacePrunedAt: number | null
}

export interface WorkspaceTaskRepositoryRecord {
  readonly repoPath: string
  readonly worktreePath: string
  readonly branch: string
  readonly baseBranch: string
}

export interface WebhookWorkspaceClaimRecord {
  readonly id: string
  readonly workspacePruningAt: number
}

export interface WorkspaceMaintenanceStore {
  listGcCandidates(): Promise<readonly WorkspaceTaskRecord[]>
  listTasks(ids: readonly string[]): Promise<readonly WorkspaceTaskRecord[]>
  listTaskRepositories(taskId: string): Promise<readonly WorkspaceTaskRepositoryRecord[]>
  anchoredTaskIds(ids: readonly string[]): Promise<ReadonlySet<string>>
  hasLiveOrRevivableChild(taskId: string): Promise<boolean>
  claimWorkspace(taskId: string, now: number): Promise<boolean>
  claimIsoWorkspace(taskId: string, now: number): Promise<boolean>
  reclaimWebhookWorkspace(taskId: string, expectedAt: number, now: number): Promise<boolean>
  finalizeWorkspace(taskId: string, now: number): Promise<boolean>
  releaseIsoClaim(taskId: string, expectedAt?: number): Promise<boolean>
  healMissingWorkspace(taskId: string, now: number): Promise<boolean>
  listStaleWebhookClaims(staleBefore: number): Promise<readonly WebhookWorkspaceClaimRecord[]>
}

export interface WorkspaceTerminalMaintenance {
  snapshotMembers(taskIds: readonly string[]): Promise<readonly MaintenanceMemberSnapshot[]>
  claim(input: {
    readonly rootTaskId: string
    readonly operation: TerminalMaintenanceOperation
    readonly members: readonly MaintenanceMemberSnapshot[]
    readonly cleanupPlanJson: string
    readonly now?: number
  }): Promise<TerminalMaintenanceClaim>
  transition(input: {
    readonly claim: TerminalMaintenanceClaim
    readonly to: TerminalMaintenanceState
    readonly now?: number
    readonly releaseMembers?: boolean
  }): Promise<TerminalMaintenanceClaim>
  complete(input: {
    readonly claim: TerminalMaintenanceClaim
    readonly now?: number
  }): Promise<void>
  listRecoverable(input: {
    readonly operation?: TerminalMaintenanceOperation
    readonly rootTaskId?: string
  }): Promise<readonly RecoverableTerminalMaintenanceClaim[]>
}

export interface WorkspaceMaintenanceFilesystem {
  exists(path: string): boolean
  isMaterializingTask(taskId: string): boolean
  removeWorkspace(
    task: WorkspaceTaskRecord,
    repositories: readonly WorkspaceTaskRepositoryRecord[],
  ): Promise<boolean>
  removeIsoContainer(task: WorkspaceTaskRecord | null, taskId: string): Promise<boolean>
  isMerged(worktreePath: string, baseBranch: string, branch: string): Promise<boolean>
  listScratchDirectories(): readonly { readonly taskId: string; readonly path: string }[]
  listWorktreeLeaves(): readonly { readonly taskId: string; readonly path: string }[]
  listIsoTaskIds(): readonly string[]
  removeAgedPath(path: string, now: number, minAgeMs: number): Promise<boolean>
  runPartialCloneGc(
    now: number,
    cloneTimeoutMs: number,
  ): Promise<{
    readonly scanned: number
    readonly removed: number
  }>
}
