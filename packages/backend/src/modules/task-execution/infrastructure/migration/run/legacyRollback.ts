import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import type { TaskRollbackCheckpointRun } from '../../../domain/taskCheckpointRollback'
import { planTaskCheckpointRollback } from '../../../domain/taskCheckpointRollback'
import { taskCheckpointRefs } from '../../../domain/taskCheckpoint'
import { decodeTaskRollbackCheckpoints, taskCheckpointLayout } from './legacyCheckpointCodec'

/** Only the frozen epoch-1 planner accepts the legacy scalar/map payload. */
type LegacyRollbackCheckpointRun = TaskRollbackCheckpointRun &
  Partial<
    Pick<
      ReturnType<typeof decodeTaskRollbackCheckpoints>,
      'checkpointScope' | 'checkpointParseError' | 'checkpointRequest'
    >
  >

type RollbackWorkspace = {
  worktreePath: string
  repos: readonly { worktreePath: string; mountPath: string }[]
}

/** Epoch-1 input boundary retained for storage readers and converter reuse. */
export function decodeTaskRollbackPlan(
  target: RollbackWorkspace,
  run: { id: string; preSnapshot: string | null; preSnapshotReposJson: string | null },
) {
  return taskRollbackPlan(
    target,
    decodeTaskRollbackCheckpoints(
      run,
      target.repos.map((repo) => repo.mountPath),
    ),
  )
}

/** The durable v1 request keeps its field names and ordering. */
export function taskRollbackPlan(target: RollbackWorkspace, run: LegacyRollbackCheckpointRun) {
  const mapped =
    run.checkpointScope === undefined
      ? taskCheckpointLayout(target.repos.map((repo) => repo.mountPath)) === 'mounts'
      : run.checkpointScope === 'mounts'
  const repositories = mapped
    ? target.repos
    : isTaskWorkspaceUnbound(target.worktreePath)
      ? []
      : [{ mountPath: '', worktreePath: target.worktreePath }]
  const snapshots = taskCheckpointRefs(run.checkpoints, 'preSnapshot')
  return {
    mapped,
    parseError: run.checkpointParseError ?? null,
    targets: planTaskCheckpointRollback(repositories, run.checkpoints),
    request:
      run.checkpointRequest ??
      (mapped
        ? { v: 1, runId: run.id, snapshots }
        : { v: 1, runId: run.id, snapshot: snapshots[''] ?? '' }),
    worktreePaths: repositories.map((repo) => repo.worktreePath),
  }
}
