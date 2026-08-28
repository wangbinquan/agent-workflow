// RFC-326 — the `collaboration` context's public TYPES (RFC-294 exact entrypoint).
//
// First slice of the context that RFC-294 makes the owner of the human gates
// (SubmitReviewDecision / GetGateView / ListPendingGateSummaries). Today it exports
// the review-anchor resolution contract only; the decision application service is
// still `services/review.ts` and consumes this surface through `public/queries`.
//
// Named exports only — no `export *`, no default (the barrel would otherwise leak
// whatever lands in `domain/` next).

import type { PatPurpose, Permission, Role } from '@agent-workflow/shared'

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
export type { ReviewAccessDecision, ReviewAccessInputs } from '../domain/reviewAccess'
export type { ReviewGateOpenDocumentDraft } from '../application/prepareReviewGateOpen'
export type {
  ReviewDecisionCommandPort,
  SubmitReviewDecisionCommandInput,
  SubmitReviewDecisionCommandResult,
} from '../application/ports/reviewDecisionCommand'
export type {
  ClarifyDecisionCommandPort,
  SubmitClarifyDecisionCommandInput,
  SubmitClarifyDecisionCommandResult,
} from '../application/ports/clarifyDecisionCommand'
export type {
  DispatchTaskQuestionsCommandInput,
  DispatchTaskQuestionsCommandResult,
  QuestionDispatchActorSnapshot,
  QuestionDispatchCommandPort,
} from '../application/ports/questionDispatchCommand'

/** Structural identity snapshot consumed by review authorization adapters. */
export interface ReviewActorUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly status: 'active' | 'disabled' | 'invited'
}

/**
 * Review-specific projection of the authenticated actor. It preserves the
 * current permission/purpose inputs without exposing the legacy auth module as
 * a cross-context public type dependency.
 */
export interface ReviewActor {
  readonly user: ReviewActorUser
  readonly source: 'session' | 'pat' | 'daemon'
  readonly permissions: ReadonlySet<Permission>
  readonly purpose?: PatPurpose
  readonly patId?: string
  readonly authorityRevision?: number
}

declare const collaborationCommandContextBrand: unique symbol

/** Opaque composition reference; DB and filesystem dependencies stay private. */
export type CollaborationCommandContext = Readonly<{
  [collaborationCommandContextBrand]: 'collaboration-command-context'
}>
