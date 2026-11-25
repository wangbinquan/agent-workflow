// RFC-326/RFC-333 — collaboration's cross-context contracts.
// Module-internal details are imported directly from their owners.

import type { PatPurpose, Permission, Role } from '@agent-workflow/shared'

// RFC-481: `PreparedHumanGateRef` is Task Execution's now (task-execution `public/types`); `HumanGateKind` left with it.
// RFC-579: the review, clarify and question-dispatch command contracts, the review access decision, the task-question
// conflict codes and the gate types they reference left this entry with the routes (now this module's inbound layer).

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

export type { ClarifyAnswerContent } from '../domain/clarifyAnswerContent'
