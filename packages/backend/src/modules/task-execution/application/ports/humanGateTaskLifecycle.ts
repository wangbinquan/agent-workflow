import type { PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import type { TaskExecutionPostCommitEventRef } from '../../domain/postCommitEventRef'
import type { OwnershipToken } from '../../domain/ownership'
import type { TaskRuntimeLifecyclePersistence } from './taskRuntimeLifecyclePersistence'

export interface HumanGateTaskParkResult {
  readonly taskRevision: number
  readonly gateRevision: number
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}

/** Named cross-context atomic operations. Provider adapters compose the task,
 * ownership, collaboration gate and committed-event participants privately. */
export interface HumanGateTaskLifecycle {
  parkPrepared(input: {
    readonly prepared: PreparedHumanGateRef
    readonly token?: OwnershipToken
    readonly now: number
  }): Promise<HumanGateTaskParkResult>
  settleManualQuestionParks(input: {
    readonly taskId: string
    readonly token?: OwnershipToken
    readonly now: number
  }): Promise<
    Readonly<{
      parked: boolean
      taskRevision: number | null
      operationIds: readonly string[]
      eventRefs: readonly TaskExecutionPostCommitEventRef[]
    }>
  >
  trySetWhenNoManualQuestionParks(
    input: Parameters<TaskRuntimeLifecyclePersistence['trySet']>[0],
  ): Promise<
    Readonly<{ kind: 'settled'; won: boolean }> | Readonly<{ kind: 'manual-question-pending' }>
  >
}
