import type { ClarifyAnswer, ClarifyDirective } from '@agent-workflow/shared'
import type { GateDecisionReceipt } from '../../domain/gateReceipt'
import type {
  QuestionDispatchDeferredReceipt,
  QuestionDispatchRerunReceipt,
} from '../../domain/questionDispatchDecision'

export interface SubmitClarifyDecisionCommandInput {
  readonly nodeRunId: string
  readonly answers: readonly ClarifyAnswer[]
  readonly directive: ClarifyDirective
  readonly ifMatchIteration?: number
  readonly expectedTaskRevision?: number
  readonly expectedGateRevision?: number
  readonly idempotencyKey?: string
}

export interface SubmitClarifyDecisionCommandResult {
  readonly taskId: string
  readonly roundKind: 'self' | 'cross'
  readonly sealedQuestionIds: readonly string[]
  readonly roundFullySealed: boolean
  readonly receipt: GateDecisionReceipt
  readonly reruns: readonly QuestionDispatchRerunReceipt[]
  readonly dispatchedEntryIds: readonly string[]
  readonly deferred: readonly QuestionDispatchDeferredReceipt[]
  readonly dispatchDeferredReason?: string
}

export interface ClarifyDecisionCommandPort {
  submit(input: SubmitClarifyDecisionCommandInput): Promise<SubmitClarifyDecisionCommandResult>
}
