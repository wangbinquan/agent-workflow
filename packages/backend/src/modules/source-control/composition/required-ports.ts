import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

// RFC-395 II-b O1: source-control owns the task facts its maintenance needs.
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

export interface WorkspaceGcTaskPort {
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

export interface TaskWorkspacePruneParticipant {
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

export interface CachedRepositoryTaskUsagePort {
  referencedAmong(
    cachedRepoIds: readonly string[],
  ): Promise<{ readonly mounted: ReadonlySet<string>; readonly requestedOnly: ReadonlySet<string> }>
  countTaskReferences(cachedRepoIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}

export interface TaskRepositorySourceRecords {
  readonly requested: readonly {
    taskId: string
    repoUrl: string | null
    cachedRepoId: string | null
  }[]
  readonly mounts: readonly {
    taskId: string
    ordinal: number
    repoUrl: string | null
    cachedRepoId: string | null
    submoduleInitError: string | null
  }[]
}

export interface TaskRepositorySourceSealingParticipant {
  updateRequestedSource(
    taskId: string,
    patch: { repoUrl?: string | null; cachedRepoId?: string | null },
  ): Promise<void>
  updateMount(
    taskId: string,
    ordinal: number,
    patch: {
      repoUrl?: string | null
      cachedRepoId?: string | null
      submoduleInitError?: string | null
    },
  ): Promise<void>
}

export interface TaskRepositorySourceSealingPort {
  listSources(): Promise<TaskRepositorySourceRecords>
  readonly participant: (tx: PersistenceTx) => TaskRepositorySourceSealingParticipant
}

export interface RepositoryWorkspaceTaskPorts {
  readonly taskUsage: CachedRepositoryTaskUsagePort
  readonly sourceSealing: TaskRepositorySourceSealingPort
}
