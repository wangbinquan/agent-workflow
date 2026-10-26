import type { TaskRepositoryCheckpoint } from './taskCheckpoint'

export interface TaskRollbackMount {
  readonly mountPath: string
  readonly worktreePath: string
}
export interface TaskCheckpointRollbackTarget extends TaskRollbackMount {
  readonly snapshot: string
}

/** Only historical runs carrying a nonempty pre-snapshot have a rollback action. */
export function planTaskCheckpointRollback(
  mounts: readonly TaskRollbackMount[],
  checkpoints: readonly TaskRepositoryCheckpoint[],
): TaskCheckpointRollbackTarget[] {
  const byMount = new Map(
    checkpoints.map((checkpoint) => [checkpoint.mountPath, checkpoint.preSnapshot]),
  )
  return mounts.flatMap((mount) => {
    const snapshot = byMount.get(mount.mountPath)
    return typeof snapshot !== 'string' || snapshot === '' ? [] : [{ ...mount, snapshot }]
  })
}

export interface TaskRollbackCheckpointRun {
  readonly id: string
  readonly checkpoints: readonly TaskRepositoryCheckpoint[]
}

/** Only recorded pre-snapshots can request rollback, including a recorded clean tree. */
export function hasTaskRollbackCheckpoint(
  run: { readonly checkpoints: readonly TaskRepositoryCheckpoint[] },
  includeCleanTree = true,
): boolean {
  return run.checkpoints.some(
    (checkpoint) =>
      checkpoint.preSnapshot !== undefined && (includeCleanTree || checkpoint.preSnapshot !== ''),
  )
}
