import { isSingleRootRepository } from '@agent-workflow/shared'
import type { TaskRollbackCheckpointRun } from '../domain/taskCheckpointRollback'
import { planTaskCheckpointRollback } from '../domain/taskCheckpointRollback'
import { taskCheckpointRefs } from '../domain/taskCheckpoint'

/** Target checkpoints always refer to real mounts, including a real ordinal-0 root mount. */
export function taskRollbackPlan(
  target: {
    readonly worktreePath: string
    readonly repos: readonly { readonly worktreePath: string; readonly mountPath: string }[]
  },
  run: TaskRollbackCheckpointRun,
) {
  const mapped = !isSingleRootRepository(target.repos.map((repo) => repo.mountPath))
  const snapshots = taskCheckpointRefs(run.checkpoints, 'preSnapshot')
  return {
    mapped,
    parseError: null,
    targets: planTaskCheckpointRollback(target.repos, run.checkpoints),
    request: mapped
      ? { v: 1 as const, runId: run.id, snapshots }
      : { v: 1 as const, runId: run.id, snapshot: snapshots[''] ?? '' },
    worktreePaths: target.repos.map((repo) => repo.worktreePath),
  }
}
