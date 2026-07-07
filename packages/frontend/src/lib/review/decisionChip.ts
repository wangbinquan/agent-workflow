// flag-audit W0 (§4.6) — single source of truth for review decision → chip kind.
// Replaces three drifted mappings that used TWO color-name systems:
//   - routes/reviews.tsx `decisionChipColor` (legacy green/red/blue/gray)
//   - routes/reviews.tsx list-row nested ternary (legacy names + awaiting→amber)
//   - components/review/ReviewDecisionInfo.tsx `chipKind` (semantic names)
// Only ReviewDecisionInfo handled 'superseded'; the other two silently fell
// back to gray. One table, semantic StatusChip kinds only.

import type { StatusChipKind } from '@/components/StatusChip'

export type ReviewDecisionView = 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'

export const DECISION_CHIP_KIND: Record<ReviewDecisionView, StatusChipKind> = {
  pending: 'neutral',
  approved: 'success',
  rejected: 'danger',
  iterated: 'info',
  superseded: 'neutral',
}

/** Tolerant accessor — unknown / null decisions render neutral instead of throwing. */
export function decisionChipKind(decision: string | null | undefined): StatusChipKind {
  if (decision === undefined || decision === null) return 'neutral'
  return DECISION_CHIP_KIND[decision as ReviewDecisionView] ?? 'neutral'
}
