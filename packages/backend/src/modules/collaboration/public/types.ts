// RFC-326 — the `collaboration` context's public TYPES (RFC-294 exact entrypoint).
//
// First slice of the context that RFC-294 makes the owner of the human gates
// (SubmitReviewDecision / GetGateView / ListPendingGateSummaries). Today it exports
// the review-anchor resolution contract only; the decision application service is
// still `services/review.ts` and consumes this surface through `public/queries`.
//
// Named exports only — no `export *`, no default (the barrel would otherwise leak
// whatever lands in `domain/` next).

export type {
  ReviewAnchorBlock,
  ReviewAnchorBlockKind,
  ReviewAnchorBudget,
  ReviewAnchorCandidate,
  ReviewAnchorDocument,
  ReviewAnchorErrorCode,
  ReviewAnchorFailure,
  ReviewAnchorHeading,
  ReviewAnchorRequest,
  ReviewAnchorResolution,
  ReviewAnchorSpan,
  ReviewAnchorSuccess,
  ReviewAnchorSuggestion,
  ReviewAnchorWarning,
} from '../domain/reviewAnchor'

export type {
  CanonicalHumanGateRequest,
  ClarifyGateDirective,
  HumanGateRequestPayload,
  ReviewGateDecision,
} from '../domain/canonicalGateRequest'
export type { GateDecisionReceipt, HumanGateIdentity } from '../domain/gateReceipt'
export type { HumanGateKind, PreparedHumanGateRef } from '../domain/humanGateOperation'
export type { ReviewGateOpenDocumentDraft } from '../application/prepareReviewGateOpen'

declare const collaborationCommandContextBrand: unique symbol

/** Opaque composition reference; DB and filesystem dependencies stay private. */
export type CollaborationCommandContext = Readonly<{
  [collaborationCommandContextBrand]: 'collaboration-command-context'
}>
