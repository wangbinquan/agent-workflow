// RFC-303 exact public vocabulary. Cross-context callers may depend on these
// types, never on task rows, activeTasks, scheduler, GC, or process internals.
import type {
  SchedulerDriverPort,
  TaskStatusPublisher,
} from '../application/ports/taskExecutionTopology'
import type { TaskStatusProjectionReadModel } from './queries'

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

/** Required by the scheduler runtime; production construction has no fallback. */
export interface SchedulerRuntimeTopology {
  readonly schedulerDriver: SchedulerDriverPort
  readonly taskStatusReadModel: TaskStatusProjectionReadModel
  readonly taskStatusPublisher: TaskStatusPublisher
}

export { SETTLES_WITHOUT_ROW_KINDS } from '../composition/dagFrontier'
