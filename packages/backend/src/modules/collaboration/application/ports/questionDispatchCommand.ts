import type { TaskActorRole } from '@agent-workflow/shared'
import type { GateDecisionReceipt } from '../../domain/gateReceipt'
import type {
  QuestionDispatchDeferredReceipt,
  QuestionDispatchRerunReceipt,
} from '../../domain/questionDispatchDecision'

export interface DispatchTaskQuestionsCommandInput {
  readonly taskId: string
  readonly entryIds: readonly string[]
  readonly expectedTaskRevision?: number
  readonly expectedGateRevision?: number
  readonly idempotencyKey?: string
}

export interface DispatchTaskQuestionsCommandResult {
  readonly taskId: string
  readonly receipt: GateDecisionReceipt
  readonly reruns: readonly QuestionDispatchRerunReceipt[]
  readonly dispatchedEntryIds: readonly string[]
  readonly deferred: readonly QuestionDispatchDeferredReceipt[]
}

export interface QuestionDispatchCommandPort {
  dispatch(input: DispatchTaskQuestionsCommandInput): Promise<DispatchTaskQuestionsCommandResult>
}

export interface QuestionDispatchActorSnapshot {
  readonly userId: string
  readonly role: TaskActorRole
}
