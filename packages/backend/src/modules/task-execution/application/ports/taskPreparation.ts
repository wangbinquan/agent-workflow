import type {
  Task,
  TaskRepo,
  TaskStatus,
  PlannedRepo,
  PlannedDirectoryNode,
} from '@agent-workflow/shared'

export interface TaskPreparationContext {
  readonly id: string
  readonly status: TaskStatus
  readonly workflowId: string
  readonly name: string
  readonly spaceKind: Task['spaceKind']
  readonly workingBranch: string | null
  readonly gitUserName: string | null
  readonly gitUserEmail: string | null
  readonly worktreePath: string
  readonly workspacePruningAt: number | null
  readonly workspacePrunedAt: number | null
  readonly requestedSource: {
    readonly repoGroupId: string | null
    readonly cachedRepoId: string | null
    readonly requestedRef: string
  }
}

export interface TaskFrozenLayout {
  repos: PlannedRepo[]
  nodes: PlannedDirectoryNode[]
}

export interface TaskPreparationQueries {
  context(taskId: string): Promise<TaskPreparationContext | undefined>
  status(taskId: string): Promise<{ readonly status: TaskStatus } | undefined>
  frozenLayout(taskId: string): Promise<TaskFrozenLayout>
}

export interface TaskPreparedRepositoryMount extends Omit<
  TaskRepo,
  'repoIndex' | 'worktreeDirName'
> {
  readonly ordinal: number
  readonly workspaceProfileVersion: number | null
  readonly workspaceProfileDigest: string | null
}

export interface TaskPreparedWorkspace {
  readonly taskId: string
  readonly worktreePath: string
  readonly branch: string
  readonly baseCommit: string | null
  readonly spaceKind: Task['spaceKind']
  readonly repositories: readonly TaskPreparedRepositoryMount[]
  readonly nodePaths: readonly string[]
}

/** 准备回填参加调用方事务；目录、挂载与主仓兼容投影共同提交。 */
export interface TaskPreparationParticipant {
  writeWorkspace(input: TaskPreparedWorkspace): Promise<void>
}
