// RFC-340 — the complete relationship-to-capability matrix for review gates.

import type { ReviewAuthorRole, ReviewCapabilities, TaskActorRole } from '@agent-workflow/shared'

export interface ReviewAccessInputs {
  readonly taskVisible: boolean
  readonly taskActorRole: TaskActorRole | null
  readonly assignedReviewer: boolean
  readonly resourceAclBypass: boolean
}

export interface ReviewAccessDecision {
  readonly capabilities: ReviewCapabilities
  /** Role snapshot used only when this actor adds a standalone comment. */
  readonly commentAuthorRole: ReviewAuthorRole | null
}

export function deriveReviewAccess(input: ReviewAccessInputs): ReviewAccessDecision | null {
  if (!input.taskVisible && !input.assignedReviewer) return null

  const canActAsTaskMember = input.taskActorRole !== null
  const canComment = canActAsTaskMember || input.assignedReviewer
  const canManageAnyComments = input.taskActorRole === 'owner' || input.resourceAclBypass

  return {
    capabilities: {
      scope: input.taskVisible ? 'task' : 'review-node',
      canAddComment: canComment,
      canEditOwnComments: canComment,
      canDeleteOwnComments: canActAsTaskMember,
      canManageAnyComments,
      canSelectDocuments: canActAsTaskMember,
      canDecide: canActAsTaskMember,
    },
    commentAuthorRole: input.taskActorRole ?? (input.assignedReviewer ? 'reviewer' : null),
  }
}
