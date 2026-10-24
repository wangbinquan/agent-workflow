export interface TaskWorktreeLocation {
  readonly taskId: string
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly repos: readonly {
    readonly ordinal: number
    readonly mountPath: string
    readonly worktreePath: string
    readonly baseCommit: string | null
  }[]
}

export interface TaskWorktreeLocator {
  find(taskId: string): Promise<TaskWorktreeLocation | null>
}
