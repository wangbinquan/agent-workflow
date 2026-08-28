import type { TaskStatus } from '@agent-workflow/shared'
import { parseExitCondition } from '../domain/loopExitCondition'
import { decodeWrapperProgress } from '../domain/wrapperProgress'

/**
 * Public read of the loop iteration used by parked-wrapper revival. Malformed
 * or absent progress retains the runtime's historical iteration-zero fallback.
 */
export function readWrapperRevivalIteration(progressJson: string | null | undefined): number {
  return decodeWrapperProgress(progressJson, () => {})?.iteration ?? 0
}

/** Public projection of the baseline carried by a persisted git-wrapper row. */
export function readWrapperGitBaseline(progressJson: string | null | undefined): string | null {
  const progress = decodeWrapperProgress(progressJson, () => {})
  if (progress?.kind !== 'git') return null
  return progress.baseline !== undefined && progress.baseline !== '' ? progress.baseline : null
}

/** Validator-facing interpretation of the runtime's exact loop-exit grammar. */
export function isValidLoopExitCondition(value: unknown): boolean {
  return parseExitCondition(value) !== null
}

export interface TaskStatusProjectionSnapshot {
  readonly taskId: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
}

export interface TaskStatusProjectionReadModel {
  find(taskId: string): Promise<TaskStatusProjectionSnapshot | null>
}

export interface TaskCallGraphWorkspace {
  readonly taskId: string
  readonly worktreePath: string
  readonly repos: readonly {
    readonly worktreeDirName: string
    readonly worktreePath: string
  }[]
}

export interface TaskCallGraphWorkspaceReadModel {
  find(taskId: string): Promise<TaskCallGraphWorkspace | null>
}

/** RFC-340: the frozen review-node catalog exposed to collaboration. */
export interface TaskReviewNodeDescriptor {
  readonly reviewNodeId: string
  readonly title: string
  readonly description: string
}

export interface TaskReviewNodeCatalog {
  readonly taskId: string
  readonly taskOwnerUserId: string | null
  readonly nodes: readonly TaskReviewNodeDescriptor[]
}

export interface TaskReviewNodeCatalogReadModel {
  find(taskId: string): Promise<TaskReviewNodeCatalog | null>
}

/** Minimal gate identity; no task logs, outputs or sibling-node state cross the boundary. */
export interface ReviewGateSubject {
  readonly nodeRunId: string
  readonly taskId: string
  readonly reviewNodeId: string
  readonly taskOwnerUserId: string | null
}

export interface ReviewGateSubjectReadModel {
  find(nodeRunId: string): Promise<ReviewGateSubject | null>
}

export interface TaskExecutionReadModels {
  readonly statusProjection: TaskStatusProjectionReadModel
  readonly callGraphWorkspace: TaskCallGraphWorkspaceReadModel
  readonly taskReviewNodes: TaskReviewNodeCatalogReadModel
  readonly reviewGateSubjects: ReviewGateSubjectReadModel
}
