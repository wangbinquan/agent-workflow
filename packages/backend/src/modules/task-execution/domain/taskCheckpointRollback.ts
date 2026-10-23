import type { TaskRepositoryCheckpoint } from './taskCheckpoint'
import type { TaskCheckpointRollbackRequest } from '@/platform/taskCheckpoint'

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
  /** Epoch-1 scalar fallback targets the workspace; map rows target their mounts. */
  readonly checkpointScope?: 'workspace' | 'mounts'
  readonly checkpointParseError?: string | null
  /** Opaque epoch-1 effect payload; preserve parsed JSON values and insertion order. */
  readonly checkpointRequest?: TaskCheckpointRollbackRequest
}

/** Empty/malformed historic maps still enter the same rollback/no-op path. */
export function hasTaskRollbackCheckpoint(
  run: TaskRollbackCheckpointRun,
  includeCleanTree = true,
): boolean {
  return (
    run.checkpointScope === 'mounts' ||
    run.checkpoints.some(
      (checkpoint) =>
        checkpoint.preSnapshot !== undefined && (includeCleanTree || checkpoint.preSnapshot !== ''),
    )
  )
}
