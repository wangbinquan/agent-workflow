// RFC-628 — the follow-up a review-resolution ledger still owes after its next step was preempted.
//
// A Case has a single "next work item" pointer. A preempting event (most often the MR lifecycle
// update caused by the employee's own push) overwrites it, so a prepared reply or an uncommitted
// review repair has no path back. The ledger itself still says what was left unfinished; settlement
// reads it through this rule so that the unfinished round is completed before anything new starts.

export type ReviewResolutionLedgerStatus = 'collected' | 'acknowledged' | 'prepared' | 'replied'

export interface ReviewResolutionFollowUpLedger {
  readonly status: ReviewResolutionLedgerStatus
  readonly publishedHeadSha: string | null
  readonly sourceHeadSha: string
}

export type ReviewResolutionFollowUp = 'reply-feedback' | 'prepare-change'

/**
 * The follow-up the ledger requires: published → reply; unpublished while the workspace has not
 * been rebuilt → freeze the change again; anything else → none.
 */
export function pendingReviewFollowUp(input: {
  readonly ledger: ReviewResolutionFollowUpLedger | null
  readonly mergeRequestHeadSha: string
}): ReviewResolutionFollowUp | null {
  const ledger = input.ledger
  if (ledger?.status !== 'prepared') return null
  // Published (or reply-only): the commit the reply refers to is already fixed.
  if (ledger.publishedHeadSha !== null) return 'reply-feedback'
  // The source head is the MR head at collection time. The employee workspace is only rebuilt when
  // the MR head moves (or after a published conflict repair, which also moves it), so an unchanged
  // head means the uncommitted repair is still in the workspace and can be frozen again.
  if (ledger.sourceHeadSha === input.mergeRequestHeadSha) return 'prepare-change'
  // The head moved: the workspace was rebuilt and the repair is gone (RFC-628 known limitation).
  return null
}
