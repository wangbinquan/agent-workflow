// RFC-493 (RFC-294 S13): the review decision policy table, moved verbatim from `infrastructure/review.ts` — per decision
// kind, whether the round bumps, the lifecycle event, the decision reason, and the rerun / rollback / supersede /
// cascade rule for the upstream.

import { type ReviewDecisionKind } from '@agent-workflow/shared'

// RFC-149: review decision policy table.
//
// `submitReviewDecision` used to branch on `args.decision` at ≥13 independent
// points (iteration bump, decisionReason derivation, rerun/rollback key pairs,
// supersede column value + marker, mint cause, cascade semantics, lifecycle
// event). Each policy dimension now lives in ONE row per decision below and
// the function keeps only the path-shape skeleton (approve early-return +
// multi-doc approve gate — D2). Adding a decision kind = adding a row: the
// mapped `satisfies` makes a missing/extra row a compile error.

/**
 * The rerun/rollback/supersede/cascade half of a decision policy. Only
 * rejected/iterated carry it — approve early-returns before the rerun block.
 * All six fields are REQUIRED (design-gate revision): an optional slot would
 * let a new row compile while silently dropping the reject/iterate asymmetry.
 */
export interface ReviewRerunPolicy {
  /** Review-node config key listing which upstream nodes re-run. */
  rerunnableKey: 'rerunnableOnReject' | 'rerunnableOnIterate'
  /** Review-node config key gating the upstream worktree rollback. */
  rollbackKey: 'rollbackFilesOnReject' | 'rollbackFilesOnIterate'
  /** Config-absent default — reject rolls files back, iterate keeps them. */
  rollbackDefault: boolean
  /** `node_runs.superseded_by_review` column value (the human-breadcrumb
   *  supersede marker derives from it byte-for-byte). */
  supersededByReview: 'rejected' | 'iterated'
  /** `rerun_cause` stamped on the freshly minted upstream retry row. */
  mintCause: 'review-reject' | 'review-iterate'
  /** Sibling-review cascade rule: reject always cascades (RFC-005 A2);
   *  iterate only when the upstream opted into sibling sync (RFC-014). */
  cascade: 'always' | 'sibling-sync-conditional'
}

export interface ReviewDecisionPolicyBase {
  /** Whether the decision bumps review_iteration (approve keeps it). */
  bumpsIteration: boolean
  /** transitionNodeRunStatus event kind closing / re-opening the review row. */
  lifecycleEvent: 'approve-review' | 'reject-review' | 'iterate-review'
  /** How doc_versions.decision_reason is derived at archive time. */
  decisionReason: 'reject-reason' | 'render-comments' | 'none'
}

/** approved FORBIDS the rerun slot; rejected/iterated must carry it in full. */
export type ReviewDecisionPolicyOf<K extends ReviewDecisionKind> = ReviewDecisionPolicyBase &
  (K extends 'approved' ? { rerun?: never } : { rerun: ReviewRerunPolicy })

/** Widened view for lookup sites indexing by a runtime ReviewDecisionKind. */
export type ReviewDecisionPolicy = ReviewDecisionPolicyOf<ReviewDecisionKind>

export const REVIEW_DECISION_POLICY = {
  approved: {
    bumpsIteration: false,
    lifecycleEvent: 'approve-review',
    decisionReason: 'none',
  },
  rejected: {
    bumpsIteration: true,
    lifecycleEvent: 'reject-review',
    decisionReason: 'reject-reason',
    rerun: {
      rerunnableKey: 'rerunnableOnReject',
      rollbackKey: 'rollbackFilesOnReject',
      rollbackDefault: true,
      supersededByReview: 'rejected',
      mintCause: 'review-reject',
      cascade: 'always',
    },
  },
  iterated: {
    bumpsIteration: true,
    lifecycleEvent: 'iterate-review',
    decisionReason: 'render-comments',
    rerun: {
      rerunnableKey: 'rerunnableOnIterate',
      rollbackKey: 'rollbackFilesOnIterate',
      rollbackDefault: false,
      supersededByReview: 'iterated',
      mintCause: 'review-iterate',
      cascade: 'sibling-sync-conditional',
    },
  },
} as const satisfies { [K in ReviewDecisionKind]: ReviewDecisionPolicyOf<K> }
