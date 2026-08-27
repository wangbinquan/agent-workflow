import type { DynamicWorkflowPhase } from '@agent-workflow/shared'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import type { ResolvedTaskDriveConfig } from '../application/drive/taskDriveTypes'

export const TASK_ENGINE_KINDS = ['dag', 'workgroup-turns', 'dw-generate'] as const

export type TaskEngineKind = (typeof TASK_ENGINE_KINDS)[number]

export interface TaskFailureDetail {
  readonly summary: string
  readonly message: string
  readonly nodeId?: string
  readonly processUnreaped?: true
}

export type TaskEngineOutcome =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'failed'; detail: TaskFailureDetail }>
  | Readonly<{ kind: 'canceled'; detail?: TaskFailureDetail }>
  | Readonly<{ kind: 'awaiting_review'; detail?: TaskFailureDetail }>
  | Readonly<{ kind: 'awaiting_human'; detail?: TaskFailureDetail }>

/** Temporary W2-C/D mechanics result retained for nested wrapper parity. */
export interface TaskScopeOutcome {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  readonly detail?: TaskFailureDetail
  readonly processUnreaped?: true
}

export function taskEngineOutcomeFromScope(result: TaskScopeOutcome): TaskEngineOutcome {
  if (result.kind === 'failed') {
    const detail = result.detail ?? {
      summary: 'task engine failed without detail',
      message: 'task-engine-missing-failure-detail',
    }
    return {
      kind: 'failed',
      detail: {
        ...detail,
        ...(result.processUnreaped === true ? { processUnreaped: true } : {}),
      },
    }
  }
  if (result.kind === 'ok') return { kind: 'ok' }
  if (result.kind === 'canceled') return { kind: 'canceled', detail: result.detail }
  if (result.kind === 'awaiting_review') {
    return { kind: 'awaiting_review', detail: result.detail }
  }
  return { kind: 'awaiting_human', detail: result.detail }
}

export interface TaskEngineSnapshot {
  readonly taskId: string
  readonly workgroupId: string | null
  readonly workgroupConfigJson: string | null
  readonly dynamicWorkflowPhase: DynamicWorkflowPhase | null
}

export interface TaskEngineContext {
  readonly task: TaskEngineSnapshot
  readonly execution: TaskExecutionContextRef
  readonly signal: AbortSignal
  readonly runtime: ResolvedTaskDriveConfig
}

export interface TaskEngine {
  readonly kind: TaskEngineKind
  drive(context: TaskEngineContext): Promise<TaskEngineOutcome>
}

export interface TaskEngineRegistry {
  resolve(kind: TaskEngineKind): TaskEngine
}
