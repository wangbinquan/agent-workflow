// RFC-395 II-b W0: T implements the participant; N consumes its generations. Dormant.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

export const INITIAL_TASK_EXECUTION_GENERATION = 0 as const
export const TASK_EXECUTION_GENERATION_CAUSES = [
  'retry',
  'resume',
  'workflow-sync',
  'review-rerun',
  'clarify-rerun',
  'repair',
  'dynamic-workflow-approval',
] as const
export type TaskExecutionGenerationCause = (typeof TASK_EXECUTION_GENERATION_CAUSES)[number]

export interface TaskExecutionGeneration {
  readonly taskId: string
  readonly generationSeq: number
  readonly cause: TaskExecutionGenerationCause | 'task-created' | 'legacy-epoch1'
  readonly previousGenerationSeq: number | null
  readonly operationRef: string | null
  readonly createdAt: number
}

export interface InitialTaskExecutionGeneration extends TaskExecutionGeneration {
  readonly generationSeq: typeof INITIAL_TASK_EXECUTION_GENERATION
  readonly cause: 'task-created'
  readonly previousGenerationSeq: null
  readonly operationRef: null
}

/** Task creation inserts this row after the root and before any run or selection,
 * in the same transaction. Migration's generation 0 keeps cause='legacy-epoch1'.
 */
export function initialTaskExecutionGeneration(
  taskId: string,
  createdAt: number,
): InitialTaskExecutionGeneration {
  return {
    taskId,
    generationSeq: INITIAL_TASK_EXECUTION_GENERATION,
    cause: 'task-created',
    previousGenerationSeq: null,
    operationRef: null,
    createdAt,
  }
}

export interface OpenTaskExecutionGeneration {
  readonly taskId: string
  readonly cause: TaskExecutionGenerationCause
  /** Stable operation identity; replay returns the original row, including its time. */
  readonly operationRef: string
  readonly previousGenerationSeq: number
  readonly createdAt: number
}

export interface TaskExecutionGenerationsParticipantInTx {
  /** Caller holds the task root lock. Allocate above every persisted generation,
   * and write the new runs and affected selections in this same transaction.
   * Reject a stale predecessor or an operationRef reused with different facts;
   * an identical replay returns its original generation. Never advance this axis
   * for an ordinary mint, attempt increment, or daemon ownership generation.
   */
  openGeneration(
    tx: PersistenceTx,
    input: OpenTaskExecutionGeneration,
  ): Promise<TaskExecutionGeneration>
}
