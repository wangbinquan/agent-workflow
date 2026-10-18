// RFC-326/RFC-333 — collaboration's cross-context contracts.
// Module-internal details are imported directly from their owners.

import type { PatPurpose, Permission, Role } from '@agent-workflow/shared'

export type { ReviewAnchorRequest } from '../domain/reviewAnchor'

export type { ReviewGateDecision } from '../domain/canonicalGateRequest'
export type { GateDecisionReceipt, HumanGateIdentity } from '../domain/gateReceipt'
export type { HumanGateKind, PreparedHumanGateRef } from '../domain/humanGateOperation'
export type { ReviewAccessDecision } from '../domain/reviewAccess'
export type {
  SubmitReviewDecisionCommandInput,
  SubmitReviewDecisionCommandResult,
} from '../application/ports/reviewDecisionCommand'
export type {
  SubmitClarifyDecisionCommandInput,
  SubmitClarifyDecisionCommandResult,
} from '../application/ports/clarifyDecisionCommand'
export type {
  DispatchTaskQuestionsCommandInput,
  DispatchTaskQuestionsCommandResult,
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
declare const collaborationCommandCapabilitiesBrand: unique symbol

/** Opaque composition reference; DB and filesystem dependencies stay private. */
export type CollaborationCommandContext<
  C extends
    | 'reviewDecisions'
    | 'questionDispatches'
    | 'clarifyDecisions'
    | 'taskExecutionReadModels' = never,
> = Readonly<{
  [collaborationCommandContextBrand]: 'collaboration-command-context'
  [collaborationCommandCapabilitiesBrand]: Readonly<Record<C, true>>
}>

/** Every capability invoked by the complete collaboration route operations. */
export type CollaborationRouteContext = CollaborationCommandContext<
  'reviewDecisions' | 'questionDispatches' | 'clarifyDecisions' | 'taskExecutionReadModels'
>
