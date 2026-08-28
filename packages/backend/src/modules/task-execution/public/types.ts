// RFC-303 exact public vocabulary. Cross-context callers may depend on these
// types, never on task rows, activeTasks, scheduler, GC, or process internals.
import type { TaskStatus } from '@agent-workflow/shared'

export type {
  SourceTerminationFence,
  SourceTerminationSnapshot,
  TaskStopCause,
  TaskStopProjection,
  WebhookTerminalCause,
} from '@/modules/task-execution/domain/sourceTermination'
export { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'

/** Safe cross-context failure codes; durable owner identities never cross here. */
export type TaskExecutionCommandErrorCode =
  | 'task-continuation-conflict'
  | 'task-continuation-stale'
  | 'task-terminal-maintenance-conflict'
  | 'task-execution-owner-conflict'
  | 'task-execution-resource-conflict'
  | 'task-execution-stale-owner'
  | 'task-execution-recovery-required'
  | 'task-execution-outcome-unknown'
  | 'task-execution-shutting-down'

export type TaskExecutionCommandResult =
  | Readonly<{ ok: true; intentRef: string; idempotent: boolean }>
  | Readonly<{
      ok: false
      code: TaskExecutionCommandErrorCode
      message: string
      winnerIntentRef?: string
    }>

export type { TaskScopeOutcome } from '../domain/taskEngine'

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

/** Closed wrapper vocabulary exposed to the remaining legacy mechanics. */
export type WrapperExecutionKind = 'wrapper-git' | 'wrapper-loop' | 'wrapper-fanout'

export interface WrapperExecutionScopeSegment {
  readonly wrapperId: string
  readonly kind: WrapperExecutionKind
}

/** Purpose-specific projection: no scope maps or generic domain types cross the public seam. */
export interface WrapperExecutionScope {
  readonly wrapperId: string
  readonly kind: WrapperExecutionKind
  readonly parentScopeId: string | null
  readonly directNodeIds: readonly string[]
  readonly path: readonly WrapperExecutionScopeSegment[]
}

export interface WrapperExecutionScopeReadModel {
  find(wrapperId: string, kind: WrapperExecutionKind): WrapperExecutionScope
}

export { SETTLES_WITHOUT_ROW_KINDS } from '../composition/dagFrontier'
