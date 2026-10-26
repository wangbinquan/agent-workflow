import { lookupKey } from '../lookups'
import { BLOCK_CODES, ConversionContractError } from '../blockCodes'

export interface TaskFacts {
  readonly taskId: string
  readonly parentTaskId: string | null
  readonly rootTaskId: string | null
  readonly status: string
  readonly startedAt: number
  readonly execution: 'executable' | 'retryable-history' | 'terminal-history'
  readonly subjectKind:
    | 'workflow'
    | 'agent'
    | 'workgroup'
    | 'digital-employee'
    | 'code-round'
    | 'unknown'
  readonly sourceId: string | null
  readonly definitionAnchorId: string
  readonly engineKind: 'dag' | 'workgroup-turns' | 'dw-generate'
  readonly spaceKind: string
  readonly workflowVersion: number | null
}
export interface TaskMountFacts {
  readonly taskId: string
  readonly layout: 'single-root' | 'mounts' | 'none'
  readonly mounts: readonly {
    readonly ordinal: number
    readonly repoKey: string
    readonly mountPath: string
    readonly worktreeDirName: string
  }[]
}
export interface RunFrame {
  readonly runId: string
  readonly taskId: string
  readonly containerRunId: string | null
  readonly scopePath: string
  readonly iteration: number | null
  readonly quality: 'recorded' | 'legacy-derived' | 'unresolved'
}
export const TASK_FACTS = lookupKey<TaskFacts>('task-execution/task-facts', 1)
export const TASK_MOUNTS = lookupKey<TaskMountFacts>('task-execution/task-mounts', 1)
export const RUN_FRAMES = lookupKey<RunFrame>('task-execution/run-frames', 1)
export function executionClass(status: string): TaskFacts['execution'] {
  switch (status) {
    case 'pending':
    case 'running':
    case 'awaiting_review':
    case 'awaiting_human':
    case 'interrupted':
      return 'executable'
    case 'failed':
    case 'canceled':
      return 'retryable-history'
    case 'done':
      return 'terminal-history'
    default:
      throw new ConversionContractError(BLOCK_CODES.unknownTaskStatus, status)
  }
}
