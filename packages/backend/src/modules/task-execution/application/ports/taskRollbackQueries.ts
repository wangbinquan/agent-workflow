/** Provider-neutral projection required before a node-run workspace rollback. */
export interface TaskRollbackRepositorySnapshot {
  readonly worktreePath: string
  readonly worktreeDirName: string
}

export interface TaskRollbackTargetSnapshot {
  readonly taskId: string
  readonly repoCount: number
  readonly worktreePath: string
  readonly repositories: readonly TaskRollbackRepositorySnapshot[]
}

/**
 * Closed task/workspace read boundary.  Provider clients and query builders
 * stay in the selected infrastructure adapter; filesystem rollback mechanics
 * consume only this immutable projection.
 */
export interface TaskRollbackQueries {
  load(taskId: string): Promise<TaskRollbackTargetSnapshot | null>
}
