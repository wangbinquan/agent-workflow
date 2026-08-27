import type { ReviewCommentAnchor } from '@agent-workflow/shared'
import type { ReviewAnchorRequest } from '../../public/types'
import type { GateDecisionReceipt } from '../../domain/gateReceipt'
import type { ReviewGateDecision } from '../../domain/canonicalGateRequest'

export interface SubmitReviewDecisionCommandInput {
  readonly nodeRunId: string
  readonly decision: ReviewGateDecision
  readonly rejectReason?: string
  readonly expectedReviewIteration: number
  readonly expectedTaskRevision?: number
  readonly expectedGateRevision?: number
  readonly idempotencyKey?: string
  readonly comments?: ReadonlyArray<{
    readonly commentText: string
    readonly docVersionId?: string
    readonly anchor?: ReviewCommentAnchor
    readonly anchorRequest?: ReviewAnchorRequest
  }>
  readonly selections?: ReadonlyArray<{
    readonly docVersionId: string
    readonly selection: 'accepted' | 'not_accepted'
  }>
}

export interface SubmitReviewDecisionCommandResult {
  readonly taskId: string
  readonly reviewIteration: number
  readonly receipt: GateDecisionReceipt
  readonly commentsAdded: number
  readonly commentsSkippedAsDuplicate: number
  readonly selectionsApplied: number
}

export interface ReviewDecisionCommandPort {
  submit(
    input: SubmitReviewDecisionCommandInput,
  ): Promise<SubmitReviewDecisionCommandResult>
}
