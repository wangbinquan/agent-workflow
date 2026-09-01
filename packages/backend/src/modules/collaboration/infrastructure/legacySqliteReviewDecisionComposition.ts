// RFC-349 SQLite compatibility bridge from collaboration's public command
// to the legacy review domain writer. Continuation ownership is the
// collaboration worker, never the request.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { TaskActorRole } from '@agent-workflow/shared'
import type {
  CollaborationCommandContext,
  ReviewDecisionCommandPort,
} from '@/modules/collaboration/public/types'
import { humanGateComposition } from '@/services/humanGateComposition'
import { submitReviewDecision as submitLegacyReviewDecision } from '@/services/review'

export function createSqliteReviewDecisionCommand(input: {
  readonly db: DbClient
  readonly appHome: string
}): ReviewDecisionCommandPort {
  return {
    async submit(command) {
      const decided = await submitLegacyReviewDecision({
        db: input.db,
        appHome: input.appHome,
        nodeRunId: command.nodeRunId,
        decision: command.decision,
        expectedReviewIteration: command.expectedReviewIteration,
        author: command.actor.user.id,
        authorRole: command.authorRole,
        actor: command.actor,
        ...(command.rejectReason === undefined ? {} : { rejectReason: command.rejectReason }),
        ...(command.expectedTaskRevision === undefined
          ? {}
          : { expectedTaskRevision: command.expectedTaskRevision }),
        ...(command.expectedGateRevision === undefined
          ? {}
          : { expectedGateRevision: command.expectedGateRevision }),
        ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
        ...(command.comments === undefined ? {} : { comments: command.comments }),
        ...(command.selections === undefined ? {} : { selections: command.selections }),
      })
      return {
        taskId: decided.taskId,
        reviewIteration: decided.reviewIteration,
        receipt: decided.receipt,
        commentsAdded: decided.batch?.commentsAdded ?? 0,
        commentsSkippedAsDuplicate: decided.batch?.commentsSkippedAsDuplicate ?? 0,
        selectionsApplied: decided.batch?.selectionsApplied ?? 0,
      }
    },
  }
}

export function createReviewDecisionCommandContext(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly authorRole: TaskActorRole
}): CollaborationCommandContext {
  const reviewDecisions = createSqliteReviewDecisionCommand({
    db: input.db,
    appHome: input.appHome,
  })
  return humanGateComposition.createCollaborationCommandContext({
    db: input.db,
    appHome: input.appHome,
    reviewDecisions,
  })
}
