// RFC-303 exact public vocabulary. Cross-context callers may depend on these
// types, never on task rows, activeTasks, scheduler, GC, or process internals.
export type {
  SourceTerminationFence,
  SourceTerminationSnapshot,
  TaskStopCause,
  TaskStopProjection,
  WebhookTerminalCause,
} from '@/modules/task-execution/domain/sourceTermination'

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

export type { SchedulerRuntimeTopology } from '../application/ports/taskExecutionTopology'
export type { TaskScopeOutcome } from '../domain/taskEngine'

export { SETTLES_WITHOUT_ROW_KINDS } from '../composition/dagFrontier'
