// RFC-395 II-b O3 — task-owned workspace and checkpoint facts for legacy code reads.

import type { TaskRepositoryCheckpoint } from '../../domain/taskCheckpoint'

export interface CodeWorkspaceRepository {
  readonly mountPath: string
  readonly worktreePath: string
  readonly baseCommit: string | null
}

export interface CodeWorkspaceTask {
  readonly id: string
  readonly status: string
  readonly spaceKind: string
  readonly worktreePath: string
  readonly baseCommit: string | null
  readonly repos: readonly CodeWorkspaceRepository[]
  /** RFC-370 §10 V16 — set on each terminal transition, cleared on resume:
   * the generation a stored code-review artifact belongs to. */
  readonly finishedAt?: number | null
}

export interface CodeNodeRunSnapshot {
  readonly id: string
  readonly seq: number
  readonly checkpoints: readonly TaskRepositoryCheckpoint[]
  readonly startedAt: number | null
  readonly wrapperProgressJson: string | null
}

export interface TaskCodeWorkspaceQueries {
  findTask(taskId: string): Promise<CodeWorkspaceTask | null>
  listNodeRuns(taskId: string): Promise<readonly CodeNodeRunSnapshot[]>
  findNodeRun(nodeRunId: string): Promise<CodeNodeRunSnapshot | null>
}
